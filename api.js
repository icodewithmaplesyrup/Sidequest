(function initSidequestBrowserAPI(global) {
  if (!global || typeof global.fetch !== 'function') return;

  async function request(path, options = {}) {
    const res = await fetch(`/.netlify/functions/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  global.SidequestAPI = {
    authEmail(payload) {
      return request('/auth/email', { method: 'POST', body: JSON.stringify(payload) });
    },
    postQuest(payload) {
      return request('/quests', { method: 'POST', body: JSON.stringify(payload) });
    },
    getMapQuests() {
      return request('/quests?scope=map', { method: 'GET' });
    },
    getReviewQueue() {
      return request('/reviews/pending', { method: 'GET' });
    },
    voteReview(id, voteType) {
      return request(`/reviews/${id}/vote`, {
        method: 'POST',
        body: JSON.stringify({ voteType }),
      });
    },
  };
})(typeof window !== 'undefined' ? window : undefined);

// netlify/functions/api.js
const demoMapQuests = [
  { id: 'q1', title: 'Wore a cape to the gym', lat: 48.8566, lng: 2.3522, xp: 500, tier: 'hard', completions: 63, trailblazer: false, username: 'frankie' },
  { id: 'q2', title: 'Ordered food in a pirate accent', lat: 34.0522, lng: -118.2437, xp: 250, tier: 'medium', completions: 201, trailblazer: false, username: 'mrod' },
  { id: 'q3', title: 'Complimented every passerby for 5 minutes', lat: 35.6762, lng: 139.6503, xp: 100, tier: 'easy', completions: 140, trailblazer: false, username: 'priya_d' },
  { id: 'q4', title: 'Convinced 3 strangers to high-five simultaneously', lat: 51.5074, lng: -0.1278, xp: 1000, tier: 'legend', completions: 22, trailblazer: true, username: 'trailking' },
];

let questCounter = 100;
const quests = [...demoMapQuests];
const reviewQueue = demoMapQuests.slice(0, 3).map((q, i) => ({
  id: `r${i + 1}`,
  questId: q.id,
  title: q.title,
  proposedXp: q.xp,
  username: q.username,
  locationLabel: i === 0 ? 'Chicago, IL' : i === 1 ? 'Austin, TX' : 'NYC',
  ageLabel: i === 0 ? '2h ago' : i === 1 ? '5h ago' : '8h ago',
  status: 'pending',
  voteSummary: null,
}));

function tierFromXp(xp) {
  if (xp >= 1000) return 'legend';
  if (xp >= 500) return 'hard';
  if (xp >= 250) return 'medium';
  return 'easy';
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  const path = event.path.replace('/.netlify/functions/api', '') || '/';
  const method = event.httpMethod;
  const body = parseBody(event);

  if (method === 'POST' && path === '/auth/email') {
    return json(200, {
      token: 'mock-jwt-token-123',
      user: {
        email: body.email || 'test@example.com',
        username: body.username || 'test_user',
        pfpUrl: null,
      },
    });
  }

  if (method === 'GET' && path.startsWith('/quests')) {
    return json(200, { quests });
  }

  if (method === 'POST' && path === '/quests') {
    if (!body.title || !body.recording?.clipId) {
      return json(400, { error: 'title and recording are required' });
    }

    questCounter += 1;
    const questId = `q${questCounter}`;
    const xp = Number(body.xp_base) || 250;
    const lat = Number(body.location?.lat);
    const lng = Number(body.location?.lng);
    const location = Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : { lat: 34.0522, lng: -118.2437 };

    const quest = {
      id: questId,
      title: body.title,
      lat: location.lat,
      lng: location.lng,
      xp,
      tier: tierFromXp(xp),
      completions: 0,
      trailblazer: false,
      username: body.username || 'you',
    };
    quests.unshift(quest);

    const reviewItem = {
      id: `r${questCounter}`,
      questId,
      title: body.title,
      proposedXp: xp,
      username: body.username || 'you',
      locationLabel: body.location?.label || 'Unknown location',
      ageLabel: 'just now',
      status: 'pending',
      voteSummary: null,
    };
    reviewQueue.unshift(reviewItem);

    return json(201, {
      id: questId,
      title: body.title,
      status: 'pending_review',
      xp_base: xp,
      recording: body.recording,
      reviewId: reviewItem.id,
      message: 'Quest submitted and queued for moderator review.',
    });
  }

  if (method === 'GET' && path === '/reviews/pending') {
    return json(200, {
      reviews: reviewQueue,
    });
  }

  const voteMatch = path.match(/^\/reviews\/([^/]+)\/vote$/);
  if (method === 'POST' && voteMatch) {
    const reviewId = voteMatch[1];
    const review = reviewQueue.find((item) => item.id === reviewId);
    if (!review) return json(404, { error: 'Review item not found' });

    const voteType = body.voteType;
    const configs = {
      approved: { status: 'approved', label: 'Approved ✓' },
      more: { status: 'more_xp', label: 'More XP ★' },
      reject: { status: 'rejected', label: 'Rejected ✗' },
    };
    if (!configs[voteType]) return json(400, { error: 'Invalid vote type' });

    review.status = configs[voteType].status;
    review.voteSummary = `Moderator voted: ${configs[voteType].label}`;

    return json(200, {
      review,
      awardedXp: 15,
    });
  }

  return json(404, { error: `Route ${method} ${path} not found.` });
};

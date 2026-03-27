// netlify/functions/api.js

exports.handler = async (event, context) => {
  // Extract the path after /api/
  const path = event.path.replace('/.netlify/functions/api', '');
  const method = event.httpMethod;

  // Parse body if it exists
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) {}
  }

  // 1. MOCK AUTH ENDPOINT
  if (method === 'POST' && path.startsWith('/auth/email')) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        token: "mock-jwt-token-123",
        user: { 
          email: body.email || "test@example.com", 
          username: body.username || "test_user",
          pfpUrl: null 
        }
      })
    };
  }

  // 2. MOCK QUEST SUBMISSION ENDPOINT
  if (method === 'POST' && path === '/quests') {
    return {
      statusCode: 201,
      body: JSON.stringify({
        id: "mock-quest-uuid",
        title: body.title,
        status: "pending_review",
        xp_base: body.xp_base || 250,
        message: "Quest successfully received by Netlify function!"
      })
    };
  }

  // Catch-all for undefined routes
  return {
    statusCode: 404,
    body: JSON.stringify({ error: `Route ${method} ${path} not found in mock backend.` })
  };
};
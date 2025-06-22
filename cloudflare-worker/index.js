export default {
  async fetch(request, env) {
    // Only allow POST requests
    if (request.method !== 'POST') {
      return new Response('Expected POST', { status: 405 });
    }

    // Set up CORS headers to allow requests from your domain
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://heyblu.ai',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Get the user's question from the request body
      const { prompt } = await request.json();

      if (!prompt) {
        return new Response('Missing prompt in request body', { status: 400 });
      }

      // Securely get the API key from the Cloudflare environment
      const geminiApiKey = env.GEMINI_API_KEY;

      if (!geminiApiKey) {
        return new Response('API key not configured in Cloudflare environment', { status: 500 });
      }
      
      const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;

      const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      };

      // Call the Google Gemini API
      const geminiResponse = await fetch(googleApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      // Check if the call to Gemini was successful
      if (!geminiResponse.ok) {
        const errorBody = await geminiResponse.text();
        console.error('Gemini API Error:', errorBody);
        return new Response(`Error from Gemini API: ${errorBody}`, { 
          status: geminiResponse.status,
          headers: corsHeaders 
        });
      }

      // Get the response and forward it to the user
      const geminiResult = await geminiResponse.json();
      
      // Add CORS headers to the final response
      const finalHeaders = new Headers(geminiResponse.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        finalHeaders.set(key, value);
      });
      finalHeaders.set('Content-Type', 'application/json');

      return new Response(JSON.stringify(geminiResult), {
        status: 200,
        headers: finalHeaders,
      });

    } catch (error) {
      console.error('Worker Error:', error);
      return new Response(`Internal Server Error: ${error.message}`, { 
        status: 500,
        headers: corsHeaders
      });
    }
  },
}; 
export default {
  async fetch(request, env) {
    // Define CORS headers to attach to responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://heyblu.ai',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // The browser sends a "preflight" OPTIONS request to ask for permission.
    // We must respond to this first.
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Now, we can handle the actual POST request.
    // We reject any other method.
    if (request.method !== 'POST') {
      return new Response('Expected POST', { status: 405 });
    }

    try {
      // Get the user's question from the request body
      const { prompt } = await request.json();

      if (!prompt) {
        return new Response('Missing prompt in request body', { status: 400, headers: corsHeaders });
      }

      // Securely get the API key from the Cloudflare environment
      const geminiApiKey = env.GEMINI_API_KEY;

      if (!geminiApiKey) {
        return new Response('API key not configured in Cloudflare environment', { status: 500, headers: corsHeaders });
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

      // Get the response and add our CORS headers before forwarding it
      const geminiResult = await geminiResponse.json();
      
      return new Response(JSON.stringify(geminiResult), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
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
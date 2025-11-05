# HeyBLU AI - Baseball Rule Assistant

> **"THAT'S NOT THE RULE!" "YES IT IS!"** - End the arguments with instant, accurate baseball rule answers.

HeyBLU AI is an intelligent baseball rule assistant that provides instant, accurate answers to rule questions across multiple leagues. Built with AI-powered semantic search and natural language processing, it helps coaches, umpires, parents, and players quickly resolve rule disputes on the field.

## 🎯 What is HeyBLU?

HeyBLU (Big League Umpire) solves the common problem of rule disputes in youth and amateur baseball. Instead of heated arguments and confused umpires, users get instant, cited answers from official rulebooks.

### Key Features

- **Multi-League Support**: MLB, USSSA, Little League International, Mill Valley AAA, BAMSBL
- **AI-Powered Search**: Semantic search finds relevant rules even with colloquial language
- **Instant Answers**: Get rule citations in seconds, not minutes
- **Voice Input**: Ask questions by speaking for hands-free use
- **PWA Support**: Install as a mobile app for offline access
- **Fallback Logic**: Automatically references appropriate rulebooks when specific rules aren't found
- **Share & Feedback**: Share answers and provide feedback to improve accuracy

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- OpenAI API key
- PostgreSQL database (optional, for logging)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/hey-blu-ai.git
   cd hey-blu-ai
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Add your environment variables:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   DATABASE_URL=your_postgresql_connection_string
   ```

4. **Build the project**
   ```bash
   npm run build
   npm run build:css
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

6. **Open in browser**
   Navigate to `http://localhost:3000`

### Production Deployment

```bash
npm run vercel-build
```

## 🏗️ Tech Stack

### Frontend
- **HTML5/CSS3**: Semantic markup with modern CSS
- **Tailwind CSS**: Utility-first CSS framework
- **Vanilla JavaScript**: No framework dependencies for maximum performance
- **PWA**: Progressive Web App with service worker and manifest

### Backend
- **Node.js**: JavaScript runtime
- **Vercel Functions**: Serverless API endpoints
- **OpenAI API**: GPT-4 for natural language processing and embeddings
- **PostgreSQL**: Question logging and analytics (optional)

### AI/ML
- **OpenAI Embeddings**: `text-embedding-3-small` for semantic search
- **GPT-4**: Natural language understanding and response generation
- **Cosine Similarity**: Custom algorithm for rule matching

### Deployment
- **Vercel**: Primary hosting platform
- **Bluehost**: Domain management and DNS
- **Formspree**: Form handling for league requests

## 📁 Project Structure

```
hey-blu-ai/
├── api/                    # Serverless API functions
│   ├── ask.js             # Main Q&A endpoint
│   ├── feedback.js        # User feedback collection
│   ├── retrieve.ts        # Short URL retrieval
│   ├── shorten.ts         # URL shortening service
│   └── data/              # Rulebook data and embeddings
├── rulebook/              # Main PWA application
│   ├── index.html         # Rule assistant interface
│   ├── share.html         # Shared answer display
│   ├── legal.html         # Legal disclaimers
│   └── manifest.json      # PWA manifest
├── pitchdeck/             # Investor pitch materials
├── dist/                  # Compiled TypeScript and CSS
├── src/                   # Source files
│   └── input.css          # Tailwind CSS source
├── images/                # Static assets
├── package.json           # Dependencies and scripts
├── vercel.json           # Vercel deployment config
└── tailwind.config.js    # Tailwind configuration
```

## 🎮 Usage

### Basic Usage

1. **Select a League**: Choose from MLB, USSSA, Little League, etc.
2. **Ask a Question**: Type or speak your rule question
3. **Get Instant Answer**: Receive cited rule with official reference
4. **Provide Feedback**: Help improve accuracy with thumbs up/down

### Example Questions

- "What is the infield fly rule?"
- "Can a runner advance on a dropped third strike?"
- "What happens if a batter is hit by a pitch?"
- "Is obstruction different from interference?"

### Voice Input

Click the microphone button to ask questions by voice. The system uses Web Speech API for speech-to-text conversion.

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4 and embeddings | Yes |
| `DATABASE_URL` | PostgreSQL connection string for logging | No |

### League Configuration

Add new leagues by:
1. Adding rulebook data to `api/data/`
2. Generating embeddings with `embed-rules.cjs`
3. Updating league selection in `rulebook/index.html`
4. Adding fallback logic in `api/ask.js`

## 📊 Analytics

The system logs all questions and answers (when `DATABASE_URL` is provided) for:
- Usage analytics
- Accuracy monitoring
- Popular question identification
- Rule coverage analysis

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and code standards.

## 🚀 Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment guide including:
- DNS configuration (GoDaddy/Vercel)
- Common issues and troubleshooting
- Mobile responsiveness requirements
- Image serving best practices
- Step-by-step deployment procedures

## 🏛️ Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical decisions and system design.

## 📄 License

This project is proprietary software. All rights reserved.

## 🔗 Links

- **Live Site**: [https://heyblu.ai](https://heyblu.ai)
- **Rule Assistant**: [https://heyblu.ai/rulebook](https://heyblu.ai/rulebook)
- **Support**: Contact through the website

## 📞 Support

For technical support or feature requests, please use the feedback system within the app or contact the development team.

---

**HeyBLU AI** - Making baseball fair, one rule at a time. ⚾

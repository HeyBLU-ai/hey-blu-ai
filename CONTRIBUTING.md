# Contributing to HeyBLU AI

Thank you for your interest in contributing to HeyBLU AI! This guide will help you get started with local development and understand our coding standards.

## 🚀 Development Setup

### Prerequisites

- **Node.js 18+** - [Download here](https://nodejs.org/)
- **Git** - [Download here](https://git-scm.com/)
- **Code Editor** - VS Code recommended
- **OpenAI API Key** - [Get one here](https://platform.openai.com/)

### Local Development

1. **Fork and Clone**
   ```bash
   git clone https://github.com/yourusername/hey-blu-ai.git
   cd hey-blu-ai
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   ```bash
   cp .env.example .env
   ```
   
   Add your environment variables to `.env`:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   DATABASE_URL=postgresql://user:password@localhost:5432/heyblu_dev
   ```

4. **Start Development Server**
   ```bash
   npm run dev
   ```

5. **Build for Production**
   ```bash
   npm run build
   npm run build:css
   ```

### Development Workflow

1. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Follow coding standards (see below)
   - Test your changes thoroughly
   - Update documentation if needed

3. **Test Changes**
   ```bash
   npm run build
   npm run build:css
   ```

4. **Commit Changes**
   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

## 📋 Code Standards

### JavaScript/TypeScript

- **ES6+ Features**: Use modern JavaScript features
- **Async/Await**: Prefer async/await over Promises
- **Error Handling**: Always handle errors gracefully
- **Comments**: Document complex logic and business rules
- **Naming**: Use descriptive, camelCase variable names

```javascript
// ✅ Good
async function handleUserQuestion(question, league) {
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, league })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error handling question:', error);
    throw error;
  }
}

// ❌ Bad
function handleQ(q, l) {
  fetch('/api/ask', {method: 'POST', body: JSON.stringify({question: q, league: l})})
    .then(r => r.json())
    .then(d => d);
}
```

### HTML/CSS

- **Semantic HTML**: Use appropriate HTML5 elements
- **Accessibility**: Include ARIA labels and keyboard navigation
- **Mobile-First**: Design for mobile, enhance for desktop
- **Tailwind Classes**: Use utility classes consistently

```html
<!-- ✅ Good -->
<button 
  class="btn btn-primary" 
  aria-label="Submit question"
  type="submit"
  id="submit-button"
>
  Submit
</button>

<!-- ❌ Bad -->
<div onclick="submit()" class="clickable">Submit</div>
```

### CSS Guidelines

- **Tailwind First**: Use Tailwind utility classes
- **Custom CSS**: Only when Tailwind doesn't provide the needed functionality
- **Responsive Design**: Use responsive prefixes (`sm:`, `md:`, `lg:`)
- **Consistent Spacing**: Use Tailwind's spacing scale

```css
/* ✅ Good - Custom CSS for complex animations */
@keyframes pulse-intro {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.05); opacity: .95; }
}

.animate-pulse-intro {
  animation: pulse-intro 3s ease-in-out infinite;
}

/* ❌ Bad - Recreating Tailwind functionality */
.custom-button {
  padding: 0.5rem 1rem;
  background-color: #3b82f6;
  color: white;
  border-radius: 0.25rem;
}
```

## 🧪 Testing Procedures

### Manual Testing

1. **Functionality Testing**
   - Test all user interactions
   - Verify API responses
   - Check error handling
   - Test on different devices/browsers

2. **Performance Testing**
   - Check page load times
   - Test with slow network connections
   - Verify PWA functionality

3. **Accessibility Testing**
   - Test with screen readers
   - Verify keyboard navigation
   - Check color contrast

### Testing Checklist

- [ ] Question submission works correctly
- [ ] Voice input functions properly
- [ ] All leagues return appropriate responses
- [ ] Fallback logic works as expected
- [ ] Feedback system captures data
- [ ] Sharing functionality works
- [ ] PWA installs correctly
- [ ] Mobile responsiveness is maintained
- [ ] Error states are handled gracefully

## 🔄 Git Workflow

### Branching Strategy

- **`main`**: Production-ready code
- **`develop`**: Integration branch for features
- **`feature/*`**: New features
- **`bugfix/*`**: Bug fixes
- **`hotfix/*`**: Critical production fixes

### Commit Message Format

Use conventional commits format:

```
type(scope): description

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance tasks

**Examples:**
```bash
feat(api): add fallback logic for missing rules
fix(ui): resolve mobile menu positioning issue
docs(readme): update installation instructions
refactor(voice): improve speech recognition accuracy
```

### Pull Request Process

1. **Create PR** with descriptive title and description
2. **Link Issues** if applicable
3. **Request Review** from team members
4. **Address Feedback** promptly
5. **Merge** after approval and passing checks

## 🏗️ Project Structure Guidelines

### File Organization

- **`api/`**: Serverless functions
- **`rulebook/`**: Main PWA application
- **`src/`**: Source files (CSS, etc.)
- **`dist/`**: Compiled output
- **`images/`**: Static assets

### Naming Conventions

- **Files**: kebab-case (`user-feedback.js`)
- **Variables**: camelCase (`userQuestion`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_CONVERSATION_LENGTH`)
- **Functions**: camelCase (`handleUserInput`)
- **Classes**: PascalCase (`ConversationManager`)

### Import/Export Standards

```javascript
// ✅ Good - Named exports
export const CONVERSATION_LIMIT = 4;
export function handleUserQuestion(question) { /* ... */ }

// ✅ Good - Default export for main functionality
export default function askApi(question, league) { /* ... */ }

// ❌ Bad - Mixed default and named exports
export default const CONVERSATION_LIMIT = 4;
```

## 🐛 Bug Reports

When reporting bugs, please include:

1. **Description**: Clear description of the issue
2. **Steps to Reproduce**: Detailed steps to recreate the bug
3. **Expected Behavior**: What should happen
4. **Actual Behavior**: What actually happens
5. **Environment**: Browser, device, OS
6. **Screenshots**: If applicable

## 💡 Feature Requests

When suggesting features:

1. **Problem**: What problem does this solve?
2. **Solution**: How should it work?
3. **Use Case**: Who would use this feature?
4. **Alternatives**: What other solutions were considered?

## 📚 Documentation

- **Code Comments**: Document complex business logic
- **README Updates**: Update when adding new features
- **API Documentation**: Document new endpoints
- **Architecture Decisions**: Update ARCHITECTURE.md for significant changes

## 🔒 Security

- **API Keys**: Never commit API keys or secrets
- **Input Validation**: Validate all user inputs
- **CORS**: Properly configure CORS headers
- **Rate Limiting**: Implement appropriate rate limiting

## 🚀 Performance

- **Bundle Size**: Keep JavaScript bundles small
- **Image Optimization**: Compress images appropriately
- **Caching**: Implement proper caching strategies
- **Lazy Loading**: Load resources when needed

## 📱 PWA Guidelines

- **Service Worker**: Update service worker for new features
- **Manifest**: Keep manifest.json updated
- **Offline Support**: Ensure core functionality works offline
- **Install Prompts**: Provide clear installation guidance

## 🤝 Code Review Guidelines

### For Reviewers

- **Be Constructive**: Provide helpful feedback
- **Test Changes**: Actually test the code
- **Ask Questions**: Clarify unclear code
- **Approve Promptly**: Don't let PRs sit idle

### For Authors

- **Respond Quickly**: Address feedback promptly
- **Explain Complex Code**: Add comments for reviewers
- **Test Thoroughly**: Don't rely on reviewers to catch bugs
- **Keep PRs Small**: Break large changes into smaller PRs

## 📞 Getting Help

- **GitHub Issues**: For bugs and feature requests
- **Discussions**: For questions and general discussion
- **Email**: Contact the maintainers directly for urgent issues

## 🎉 Recognition

Contributors will be recognized in:
- README.md contributors section
- Release notes
- Project documentation

Thank you for contributing to HeyBLU AI! Together, we're making baseball fairer and more enjoyable for everyone. ⚾

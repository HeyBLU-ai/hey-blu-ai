(function () {
'use strict';

function showActionToast(message) {
  let toast = document.getElementById('action-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'action-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showActionToast._timer);
  showActionToast._timer = setTimeout(() => toast.classList.remove('visible'), 1800);
}

// --- TEXT-TO-SPEECH FUNCTION ---
    function speakFirstSentence(text) {
      if (!text) return;
      
      try {
        // Extract only the natural language explanation (before "Rule X:")
        let naturalLanguage = text;
        const ruleMatch = text.match(/Rule \d+:/);
        if (ruleMatch) {
          naturalLanguage = text.split(ruleMatch[0])[0].trim();
        }
        // Remove any markdown or HTML tags if present
        const strippedText = naturalLanguage.replace(/<[^>]*>/g, '').trim();
        // Only speak the first sentence or two (roughly 200 characters max)
        const shortText = strippedText.split(/[.?!]/).slice(0, 2).join('. ') + '.';
        const utterance = new SpeechSynthesisUtterance(shortText);
        utterance.lang = 'en-US';
        utterance.rate = 0.9;
        utterance.pitch = 1.05;
        utterance.volume = 0.95;
        // Always use the preferred American English voice if available
        const voices = speechSynthesis.getVoices();
        const preferred = voices.find(v => v.name === 'English United States (en_US)');
        if (preferred) {
          utterance.voice = preferred;
          console.log('Using preferred voice:', preferred.name);
        }
        speechSynthesis.speak(utterance);
      } catch (error) {
        console.error('Error in speakFirstSentence:', error);
        console.error('Text that caused error:', text);
      }
    }

    // --- STATE MANAGEMENT ---
    let conversation = []; // Holds the entire chat history: [{ user, ai, league, shortUrl, feedbackStatus }]
    let lastUserQuestion = '';
    const CONVERSATION_LIMIT = 4;
    const INTERVIEW_ESCAPE_LABEL = 'None of these / Ask standard question';
    let isAsking = false;
    let isListening = false;
    let voiceSafetyTimer = null;
    const VOICE_LISTEN_TIMEOUT_MS = 30000;

    // Interview state — stored in memory only so a page refresh always clears it.
    let interviewState = {
      active:           false,
      matrix_id:        null,
      matrix_label:     null,
      originalQuestion: null,
      originalLeague:   null,
      answers:          {},
      pendingTurnIndex: null,
    };

    // --- DOM ELEMENT REFERENCES ---
    const questionInput                = document.getElementById("question-text");
    const leagueSelect                 = document.getElementById("league-select");
    const askForm                      = document.getElementById("ask-form");
    const submitButton                 = document.getElementById("submit-button");
    const clearButton                  = document.getElementById("clear-button");
    const micButton                    = document.getElementById("mic-button");
    const conversationHistoryContainer = document.getElementById("conversation-history");
    const interviewPanel               = document.getElementById("interview-panel");
    const interviewOptionsEl           = document.getElementById("interview-options");
    const interviewCancelBtn           = document.getElementById("interview-cancel");
    const mainContainer                = document.querySelector(".container");
    const refineSection = document.getElementById("refine-section");
    const refineInput = document.getElementById("refine-input");
    const refineBtn = document.getElementById("refine-btn");
    const feedbackSection = document.getElementById("feedback-section");
    const feedbackTextarea = document.getElementById("feedback-textarea");
    const submitFeedbackBtn = document.getElementById("submit-feedback-btn");
    const skipFeedbackBtn = document.getElementById("skip-feedback-btn");
    const feedbackModal = document.getElementById("feedback-modal");
    const closeFeedbackModalButton = feedbackModal ? feedbackModal.querySelector(".close-button") : null;
    const cancelFeedbackButton = document.getElementById("cancel-feedback");
    const submitFeedbackButton = document.getElementById("submit-feedback");
    const feedbackTextareaOld = document.getElementById("feedback-text");

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const speechSupported = !!SpeechRecognition;

    if (!questionInput || !submitButton || !clearButton || !micButton) {
      console.error('[rulebook] Missing core controls — buttons will not work.');
      showActionToast('Page failed to load. Please refresh.');
      return;
    }

    // Restore controls when iOS/Android returns this page from back-forward cache
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      isAsking = false;
      isListening = false;
      clearTimeout(voiceSafetyTimer);
      voiceSafetyTimer = null;
      unlockInputControls();
    });

    // --- EVENT LISTENERS ---

    function updateSubmitButtonState() {
      submitButton.disabled = isAsking || isListening;
    }

    function setAskingState(asking) {
      isAsking = asking;
      submitButton.disabled = asking || isListening;
      micButton.disabled = asking || isListening;
      questionInput.disabled = asking;
      clearButton.disabled = false;
      updateSubmitButtonState();
    }

    function unlockInputControls() {
      setAskingState(false);
      if (!isListening) {
        micButton.disabled = !speechSupported;
        questionInput.disabled = false;
      }
      updateSubmitButtonState();
    }

    function resetVoiceUi() {
      clearTimeout(voiceSafetyTimer);
      voiceSafetyTimer = null;
      isListening = false;
      micButton.textContent = "🎤 Ask by Voice";
      if (!isAsking) {
        micButton.disabled = !speechSupported;
        questionInput.disabled = false;
      }
      updateSubmitButtonState();
    }

    ["input", "keyup", "change", "paste"].forEach((evt) => {
      questionInput.addEventListener(evt, updateSubmitButtonState);
    });
    questionInput.addEventListener("focus", () => {
      setTimeout(() => submitButton.scrollIntoView({ behavior: "smooth", block: "nearest" }), 300);
    });

    const askFormEl = askForm || questionInput.closest("form") || document;
    askFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      handleNewQuestion(questionInput.value);
    });

    clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      resetConversation();
      showActionToast('Form cleared');
    });

    // Event delegation for dynamically created buttons (feedback, share, speech)
    if (!conversationHistoryContainer) {
      console.warn('[rulebook] conversation-history container missing');
    } else conversationHistoryContainer.addEventListener('click', (event) => {
      const target = event.target;
      console.log("Click event on:", target.className, target.dataset);
      
      const turnIndex = target.dataset.index;
      if (turnIndex === undefined) return; // Not a button with data-index

      const turn = conversation[turnIndex];

      if (target.classList.contains('icon-btn')) {
        if (target.dataset.feedbackType === 'positive') {
          handleThumbsUp(turn, target);
        } else if (target.dataset.feedbackType === 'negative') {
          handleThumbsDown(turn, target);
        } else if (target.classList.contains('speech-btn')) {
          // Handle speech button click
          const turnIndex = parseInt(target.dataset.index);
          const textToSpeak = window.speechTexts[turnIndex];
          console.log("Speech button clicked, text:", textToSpeak);
          speakFirstSentence(textToSpeak);
        }
      } else if (target.classList.contains('share-btn')) {
        handleShare(turn.user, turn.ai, turn.league, turn.shortUrl);
      }
    });

    // Refine button click
    if (refineBtn) refineBtn.addEventListener('click', () => {
      const context = refineInput.value.trim();
      if (!context) return; // No context to add

      // Combine last user question and new context
      const refinedQ = `${lastUserQuestion}. ${context}`;
      handleNewQuestion(refinedQ); // Submit as a new question
      refineInput.value = ''; // Clear refine input
      refineSection.style.display = 'none'; // Hide refine section after submission
      feedbackSection.style.display = 'none'; // Hide feedback section after submission
    });

    // Feedback button clicks
    if (submitFeedbackBtn) submitFeedbackBtn.addEventListener('click', () => {
      const feedback = feedbackTextarea.value.trim();
      const currentTurn = conversation[conversation.length - 1];
      if (currentTurn && currentTurn.feedbackStatus === 'negative') {
        submitFeedbackToApi(currentTurn, false, feedback);
      }
      feedbackSection.style.display = 'none';
      feedbackTextarea.value = '';
    });

    if (skipFeedbackBtn) skipFeedbackBtn.addEventListener('click', () => {
      const currentTurn = conversation[conversation.length - 1];
      if (currentTurn && currentTurn.feedbackStatus === 'negative' && !currentTurn.feedbackSubmitted) {
        submitFeedbackToApi(currentTurn, false, '');
      }
      feedbackSection.style.display = 'none';
      feedbackTextarea.value = '';
    });

    // Modal close buttons
    if (closeFeedbackModalButton) {
      closeFeedbackModalButton.addEventListener('click', () => feedbackModal.style.display = 'none');
    }
    if (cancelFeedbackButton) {
      cancelFeedbackButton.addEventListener('click', () => feedbackModal.style.display = 'none');
    }
    if (submitFeedbackButton) submitFeedbackButton.addEventListener('click', () => {
      const currentTurn = feedbackModal.currentTurn;
      const feedback = feedbackTextareaOld?.value?.trim() ?? '';
      if (currentTurn) {
        submitFeedbackToApi(currentTurn, false, feedback);
      }
      feedbackModal.style.display = 'none';
      if (feedbackTextareaOld) feedbackTextareaOld.value = '';
    });

    // Close modal if clicked outside content
    window.addEventListener('click', (event) => {
      if (event.target === feedbackModal) {
        feedbackModal.style.display = 'none';
        feedbackTextarea.value = '';
      }
    });

    // Interview panel — option button clicks (event delegation)
    if (interviewOptionsEl) interviewOptionsEl.addEventListener('click', (event) => {
      const escapeBtn = event.target.closest('.interview-escape-btn');
      if (escapeBtn && !escapeBtn.disabled) {
        escapeInterviewToStandardRag();
        return;
      }
      const btn = event.target.closest('.interview-option-btn');
      if (!btn || btn.disabled || btn.classList.contains('interview-escape-btn')) return;
      submitInterviewAnswer(btn.dataset.questionId, btn.dataset.answer);
    });

    // Interview cancel — full reset
    if (interviewCancelBtn) interviewCancelBtn.addEventListener('click', () => {
      resetConversation();
    });

    // --- CORE FUNCTIONS ---

    function formatAnswerText(text) {
        // Split the text into natural language explanation and quoted rule
        const parts = text.split(/Rule \d+:/);
        if (parts.length > 1) {
            const ruleMatch = text.match(/Rule \d+:/);
            const ruleNumber = ruleMatch[0];
            const naturalLanguage = parts[0].trim();
            const quotedRule = ruleNumber + parts[1].trim();
            
            return `${naturalLanguage}<div class="rule-quote">${quotedRule}</div>`;
        }
        return text;
    }

    function applyDisclaimerMeta(turn, data) {
      if (!turn || !data) return;
      turn.leagueDisplayName          = data.league_display_name ?? data.originalLeague ?? turn.league;
      turn.leagueWebsiteUrl           = data.league_website_url ?? null;
      turn.leagueLinkText             = data.league_link_text ?? turn.leagueDisplayName;
      turn.fallbackLeagueDisplayName  = data.fallback_league_display_name ?? data.fallbackLeague ?? null;
      turn.fallbackLeagueWebsiteUrl   = data.fallback_league_website_url ?? null;
      turn.fallbackLeagueLinkText     = data.fallback_league_link_text ?? turn.fallbackLeagueDisplayName;
    }

    function renderLeagueReference(name, url, linkText) {
      const label = linkText || name;
      if (url) {
        return `<a href="${url}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">${label}</a>`;
      }
      return `<span class="font-medium">${name}</span>`;
    }

    function generateDisclaimerHtml(league, turn = null) {
        if (!league) return '';

        const primaryName = turn?.leagueDisplayName || league;
        const primaryUrl  = turn?.leagueWebsiteUrl ?? null;
        const primaryLink = turn?.leagueLinkText || primaryName;

        // Handle fallback cases
        if (turn && turn.usedFallback) {
            const fallbackName = turn.fallbackLeagueDisplayName || turn.fallbackLeague || 'the governing rulebook';
            const fallbackUrl  = turn.fallbackLeagueWebsiteUrl ?? null;
            const fallbackLink = turn.fallbackLeagueLinkText || fallbackName;

            const primaryRef  = renderLeagueReference(primaryName, primaryUrl, primaryLink);
            const fallbackRef = renderLeagueReference(fallbackName, fallbackUrl, fallbackLink);
            const visitLine   = (primaryUrl || fallbackUrl)
              ? `For the complete, official rulebooks, visit ${primaryRef} and ${fallbackRef}.`
              : `For the complete, official rulebooks, consult ${primaryRef} and ${fallbackRef} directly.`;

            return `
                <div class="rule-disclaimer">
                    <p class="text-xs text-gray-600 leading-relaxed">
                        <strong>Fallback Notice:</strong> This question was not specifically covered in <span class="font-medium">${primaryName}</span> rules,
                        so we referenced <span class="font-medium">${fallbackName}</span> rules as the governing authority.
                        ${visitLine}
                        This interpretation is for educational purposes only and should not replace official rulebooks or umpire decisions.
                    </p>
                </div>
            `;
        }

        const primaryRef = renderLeagueReference(primaryName, primaryUrl, primaryLink);
        const visitLine  = primaryUrl
          ? `For the complete, official rulebook, visit ${primaryRef}.`
          : `For the complete, official rulebook, consult ${primaryRef} directly.`;

        return `
            <div class="rule-disclaimer">
                <p class="text-xs text-gray-600 leading-relaxed">
                    <strong>Disclaimer:</strong> This answer references <span class="font-medium">${primaryName}</span> rules.
                    ${visitLine}
                    This interpretation is for educational purposes only and should not replace official rulebooks or umpire decisions.
                </p>
            </div>
        `;
    }

    function resetConversation() {
      if (interviewState.active) exitInterviewMode();
      interviewState = { active: false, matrix_id: null, matrix_label: null, originalQuestion: null, originalLeague: null, answers: {}, pendingTurnIndex: null };
      conversation = [];
      conversationHistoryContainer.innerHTML = '';
      questionInput.value = '';
      lastUserQuestion = '';
      refineSection.style.display = 'none';
      feedbackSection.style.display = 'none';
      isAsking = false;
      isListening = false;
      clearTimeout(voiceSafetyTimer);
      voiceSafetyTimer = null;
      unlockInputControls();
    }

    function handleNewQuestion(questionText) {
      const question = questionText.trim();
      if (!question) return;

      lastUserQuestion = question; // Store the current question for potential refinement

      const selectedLeague = leagueSelect.value;
      const userTurn = { user: question, league: selectedLeague, ai: null, shortUrl: null, feedbackStatus: null, refined: false };
      conversation.push(userTurn);

      renderConversation(); // Show the user's question immediately with a loading state
      // Don't clear the input field immediately - let the user see what was transcribed
      // questionInput.value = ''; // Clear main input field

      askApi(question, selectedLeague);
    }

    async function askApi(question, league, options = {}) {
      const { forceRag = false } = options;
      const currentTurnIndex = conversation.length - 1;
      const conversationContext = conversation
        .slice(0, currentTurnIndex)
        .slice(-CONVERSATION_LIMIT)
        .map(t => ({ user: t.user, ai: t.ai, league: t.league }));

      renderConversation(); // show spinner for this turn
      setAskingState(true);

      let wentToInterview = false;

      try {
        const body = { question, league, conversation: conversationContext };
        if (forceRag) {
          body.force_rag = true;
        } else if (interviewState.active) {
          body.matrix_state = { matrix_id: interviewState.matrix_id, answers: { ...interviewState.answers } };
        }

        const response = await fetch('/api/ask-v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // ── State B: judgment call — start the interview ──────────────────
        if (data.state === 'needs_clarification') {
          wentToInterview = true;
          enterInterviewMode(data, question, league, currentTurnIndex);
          return;
        }

        // ── State A (answered) or State C (ruling) — standard flow ────────
        const reply = data?.reply || data?.message || 'No answer returned.';
        conversation[currentTurnIndex].ai     = reply;
        conversation[currentTurnIndex].league = league;
        if (data.usedFallback) {
          conversation[currentTurnIndex].usedFallback   = true;
          conversation[currentTurnIndex].fallbackLeague = data.fallbackLeague;
          conversation[currentTurnIndex].originalLeague = data.originalLeague;
        }
        applyDisclaimerMeta(conversation[currentTurnIndex], data);

        const shortUrl = await getShortUrl(question, reply, league, '');
        conversation[currentTurnIndex].shortUrl = shortUrl;

      } catch (err) {
        console.error('API Error:', err);
        conversation[currentTurnIndex].ai = `<p style="color:red;">Something went wrong. Please try again.</p>`;
      } finally {
        if (!wentToInterview) {
          if (interviewState.active) exitInterviewMode();
          renderConversation();
          unlockInputControls();
          conversationHistoryContainer.scrollTop = conversationHistoryContainer.scrollHeight;
        }
      }
    }

    // ── Active Interviewer functions ──────────────────────────────────────────

    function enterInterviewMode(data, question, league, pendingTurnIndex) {
      interviewState.active           = true;
      interviewState.matrix_id        = data.matrix_id;
      interviewState.matrix_label     = data.matrix_label;
      interviewState.originalQuestion = question;
      interviewState.originalLeague   = league;
      interviewState.pendingTurnIndex = pendingTurnIndex;
      // answers carries over if we were already mid-interview

      mainContainer.classList.add('interview-active');
      conversationHistoryContainer.style.display = 'none';
      interviewPanel.style.display = 'block';

      renderInterviewPanel(data);
    }

    function exitInterviewMode() {
      interviewState.active = false;

      mainContainer.classList.remove('interview-active');
      interviewPanel.style.display = 'none';
      conversationHistoryContainer.style.display = '';

      unlockInputControls();
    }

    function renderInterviewPanel(data) {
      const { matrix_label, matrix_id, current_question, progress } = data;

      document.getElementById('interview-label').textContent     = matrix_label;
      document.getElementById('interview-league-tag').textContent = interviewState.originalLeague || '';
      document.getElementById('interview-question').textContent  = current_question.text;

      const answeredCount = progress.answered ?? 0;
      const totalEst      = (progress.remaining_estimated ?? 0) + answeredCount;
      document.getElementById('interview-progress').textContent =
        totalEst > 1
          ? `Question ${answeredCount + 1} of ~${totalEst}`
          : 'One quick question';

      // Build option buttons
      interviewOptionsEl.innerHTML = '';
      current_question.options.forEach((option, idx) => {
        const btn       = document.createElement('button');
        btn.className   = `interview-option-btn ${idx === 0 ? 'opt-primary' : 'opt-alt'}`;
        btn.textContent = option;
        btn.dataset.questionId = current_question.id;
        btn.dataset.answer     = option;
        interviewOptionsEl.appendChild(btn);
      });

      appendInterviewEscapeHatch();

      interviewCancelBtn.style.display = 'inline-block';
    }

    function appendInterviewEscapeHatch() {
      const escapeBtn       = document.createElement('button');
      escapeBtn.type        = 'button';
      escapeBtn.className   = 'interview-option-btn opt-escape interview-escape-btn';
      escapeBtn.textContent = INTERVIEW_ESCAPE_LABEL;
      interviewOptionsEl.appendChild(escapeBtn);
    }

    function buildConversationContext(upToIndex) {
      return conversation
        .slice(0, upToIndex)
        .slice(-CONVERSATION_LIMIT)
        .map(t => ({ user: t.user, ai: t.ai, league: t.league }));
    }

    async function escapeInterviewToStandardRag() {
      const question = interviewState.originalQuestion;
      const league   = interviewState.originalLeague;
      const idx      = interviewState.pendingTurnIndex;
      if (!question || idx === null) return;

      interviewOptionsEl.innerHTML = `
        <div class="interview-loading">
          <div class="spinner"></div>
          <span>Looking up the rule directly\u2026</span>
        </div>`;
      interviewCancelBtn.style.display = 'none';
      setAskingState(true);

      try {
        const response = await fetch('/api/ask-v2', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            question,
            league,
            conversation: buildConversationContext(idx),
            force_rag:    true,
          }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.state === 'needs_clarification') {
          throw new Error('Standard lookup was routed to the decision tree again.');
        }

        const reply = data.reply || data.message || 'No answer returned.';
        conversation[idx].ai     = reply;
        conversation[idx].league = league;
        if (data.state === 'unverifiable') {
          conversation[idx].unverifiable = true;
        }
        if (data.usedFallback) {
          conversation[idx].usedFallback   = true;
          conversation[idx].fallbackLeague = data.fallbackLeague;
          conversation[idx].originalLeague = data.originalLeague;
        }
        applyDisclaimerMeta(conversation[idx], data);

        exitInterviewMode();
        renderConversation();
        conversationHistoryContainer.scrollTop = conversationHistoryContainer.scrollHeight;

        getShortUrl(question, reply, league, '')
          .then(url => {
            if (url) {
              conversation[idx].shortUrl = url;
              renderConversation();
            }
          });

        speakFirstSentence(reply.replace(/<[^>]*>/g, ''));
      } catch (err) {
        console.error('Interview escape error:', err);
        interviewOptionsEl.innerHTML = `
          <p style="color:#dc2626;font-size:0.88rem;margin-bottom:0.75rem;">
            Could not run a standard lookup. Please try again.
          </p>`;
        const retryBtn     = document.createElement('button');
        retryBtn.className = 'interview-option-btn opt-primary interview-escape-btn';
        retryBtn.textContent = INTERVIEW_ESCAPE_LABEL;
        interviewOptionsEl.appendChild(retryBtn);
        interviewCancelBtn.style.display = 'inline-block';
      } finally {
        unlockInputControls();
      }
    }

    async function submitInterviewAnswer(questionId, answer) {
      // Store answer (normalise to lowercase to match context_template keys)
      interviewState.answers[questionId] = answer.toLowerCase();

      // Show inline loading state
      interviewOptionsEl.innerHTML = `
        <div class="interview-loading">
          <div class="spinner"></div>
          <span>${interviewState.pendingTurnIndex !== null ? 'Looking up the rule\u2026' : 'One moment\u2026'}</span>
        </div>`;
      interviewCancelBtn.style.display = 'none';

      try {
        const response = await fetch('/api/ask-v2', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            question:     interviewState.originalQuestion,
            league:       interviewState.originalLeague,
            conversation: [],
            matrix_state: {
              matrix_id: interviewState.matrix_id,
              answers:   { ...interviewState.answers },
            },
          }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.state === 'needs_clarification') {
          // More questions — stay in interview mode
          renderInterviewPanel(data);

        } else if (data.state === 'ruling' || data.state === 'answered') {
          // Interview complete — populate the pending conversation turn
          const idx = interviewState.pendingTurnIndex;
          const reply = data.reply || data.message || 'No answer returned.';

          conversation[idx].ai     = reply;
          conversation[idx].league = interviewState.originalLeague;
          if (data.usedFallback) {
            conversation[idx].usedFallback   = data.usedFallback;
            conversation[idx].fallbackLeague = data.fallbackLeague;
            conversation[idx].originalLeague = data.originalLeague;
          }
          applyDisclaimerMeta(conversation[idx], data);

          exitInterviewMode();
          renderConversation();
          conversationHistoryContainer.scrollTop = conversationHistoryContainer.scrollHeight;

          // Short URL async — don't block the ruling display
          getShortUrl(interviewState.originalQuestion || conversation[idx].user, reply, conversation[idx].league, '')
            .then(url => {
              if (url) {
                conversation[idx].shortUrl = url;
                renderConversation();
              }
            });

          // Speak the first sentence of the ruling
          speakFirstSentence(reply.replace(/<[^>]*>/g, ''));
        }

      } catch (err) {
        console.error('Interview follow-up error:', err);

        // Show error inline with a retry option
        interviewOptionsEl.innerHTML = `
          <p style="color:#dc2626;font-size:0.88rem;margin-bottom:0.75rem;">
            Something went wrong. Please try again.
          </p>`;
        const retryBtn     = document.createElement('button');
        retryBtn.className = 'interview-option-btn opt-primary';
        retryBtn.textContent = 'Try again';
        retryBtn.addEventListener('click', () => submitInterviewAnswer(questionId, answer));
        interviewOptionsEl.appendChild(retryBtn);
        appendInterviewEscapeHatch();
        interviewCancelBtn.style.display = 'inline-block';
      }
    }

    // ─────────────────────────────────────────────────────────────────────────

    function renderConversation() {
      conversationHistoryContainer.innerHTML = ''; // Clear existing content
      if (conversation.length === 0) return;
      const turn = conversation[conversation.length - 1];
      const turnElement = document.createElement('div');
      turnElement.className = 'conversation-turn';

      // Do NOT display user-question-display bubble

      // AI Answer (or loading spinner)
      let aiContentHtml = '';
      const shortSpoken = turn.ai ? turn.ai.replace(/<[^>]*>/g, '').trim() : '';
      
      console.log("Original AI text:", turn.ai);
      console.log("Short spoken text:", shortSpoken);
      
      // More comprehensive escaping for JavaScript string literals
      const escapedText = shortSpoken
        .replace(/\\/g, '\\\\')  // Escape backslashes first
        .replace(/'/g, "\\'")    // Escape single quotes
        .replace(/"/g, '\\"')    // Escape double quotes
        .replace(/\n/g, ' ')     // Replace newlines with spaces
        .replace(/\r/g, ' ')     // Replace carriage returns with spaces
        .replace(/\t/g, ' ')     // Replace tabs with spaces
        .replace(/\f/g, ' ')     // Replace form feeds with spaces
        .replace(/\v/g, ' ');    // Replace vertical tabs with spaces
        
      console.log("Escaped text:", escapedText);
      
      // Store the clean text in a global array to avoid data attribute length limits
      if (!window.speechTexts) window.speechTexts = [];
      window.speechTexts[conversation.length - 1] = shortSpoken; // Store clean text, not escaped
      
      const speechButton = turn.ai ? `<button class="icon-btn speech-btn" data-index="${conversation.length - 1}">🔈 Listen</button>` : '';
      if (turn.ai) {
        // DOMPurify.sanitize strips any injected scripts/event-handlers from
        // AI-generated content before it is written to the DOM.
        aiContentHtml = DOMPurify.sanitize(marked.parse(formatAnswerText(turn.ai)));
      } else {
        aiContentHtml = `<div class="spinner"></div> Checking the rulebook...`;
      }

      const shareButtonHtml = turn.shortUrl ? `<button class="share-btn" data-index="${conversation.length - 1}">Share</button>` : '';

      // Generate disclaimer HTML based on league and fallback info
      const disclaimerHtml = generateDisclaimerHtml(turn.league, turn);
      
      turnElement.innerHTML += `
        <div class="answer-box">
          ${aiContentHtml}
        </div>
        ${disclaimerHtml}
        <div class="feedback-row">
          <span class="feedback-question">Was this answer helpful?</span>
          <button class="icon-btn ${turn.feedbackStatus === 'positive' ? 'active' : ''}" title="Helpful" data-index="${conversation.length - 1}" data-feedback-type="positive">👍 Yes</button>
          <button class="icon-btn ${turn.feedbackStatus === 'negative' ? 'active' : ''}" title="Not Helpful" data-index="${conversation.length - 1}" data-feedback-type="negative">👎 No</button>
          ${speechButton}
          ${shareButtonHtml}
          <span class="source">Answered for ${turn.league || 'Unknown League'}</span>
        </div>
      `;

      conversationHistoryContainer.appendChild(turnElement);
      conversationHistoryContainer.scrollTop = conversationHistoryContainer.scrollHeight;
    }

    // --- UTILITY & HANDLER FUNCTIONS ---

    function plainAiResponse(html) {
      return (html ?? '').replace(/<[^>]*>/g, '').trim();
    }

    function disableFeedbackButtons(turnElement) {
      if (!turnElement) return;
      turnElement.querySelectorAll('.icon-btn[data-feedback-type]').forEach(icon => {
        icon.disabled = true;
        icon.classList.add('opacity-50');
      });
    }

    function submitFeedbackToApi(turn, isPositive, comments = '') {
      if (!turn || turn.feedbackSubmitted) return;
      turn.feedbackSubmitted = true;

      fetch('/api/submit-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          league_slug: turn.league,
          question: turn.user,
          ai_response: plainAiResponse(turn.ai),
          is_positive: isPositive,
          comments: comments || null,
        }),
      }).then(async response => {
        if (!response.ok) {
          turn.feedbackSubmitted = false;
          console.error('Failed to send feedback');
          return;
        }
        const result = await response.json().catch(() => ({}));
        if (!isPositive && result.cacheDeleted > 0) {
          console.log(`Cleared ${result.cacheDeleted} cached answer(s) for negative feedback.`);
        }
      }).catch(error => {
        turn.feedbackSubmitted = false;
        console.error('Error sending feedback:', error);
      });
    }

    function handleThumbsUp(turn, button) {
      if (turn.feedbackStatus) return;

      turn.feedbackStatus = 'positive';
      disableFeedbackButtons(button?.closest('.conversation-turn'));
      if (button) button.classList.add('active');

      refineSection.style.display = 'none';
      feedbackSection.style.display = 'none';

      submitFeedbackToApi(turn, true);
    }

    function handleThumbsDown(turn, button) {
      if (turn.feedbackStatus) return;

      turn.feedbackStatus = 'negative';
      disableFeedbackButtons(button?.closest('.conversation-turn'));
      if (button) button.classList.add('active');

      if (!turn.refined) {
        refineSection.style.display = 'block';
        refineInput.value = '';
        feedbackSection.style.display = 'block';
        feedbackTextarea.value = '';
        turn.refined = true;
      } else {
        refineSection.style.display = 'none';
        feedbackSection.style.display = 'block';
        feedbackTextarea.value = '';
      }
    }

    function openFeedbackModal(turn, button) {
      feedbackModal.style.display = 'flex';
      feedbackModal.currentTurn = turn;
      feedbackModal.currentTurn.feedbackButton = button;
      if (feedbackTextareaOld) feedbackTextareaOld.value = '';
    }

    function handleShare(question, answer, league, shortUrl) {
      if (!shortUrl) {
        // Fallback if short URL wasn't generated
        const shareText = `Check out this baseball rule answer from HeyBLU.AI:\nQuestion: "${question}"\nAnswer: "${answer}"\nLeague: ${league}`;
        document.execCommand('copy', false, shareText); // Use execCommand for clipboard
        alert('Answer copied to clipboard!');
        return;
      }

      if (navigator.share) {
        // For mobile sharing, just share the URL with a clean title
        // This prevents text from appearing before the URL
        navigator.share({
          title: 'Baseball Rule Answer from HeyBLU.AI',
          url: shortUrl
        }).catch(error => {
          console.log('Error sharing:', error);
          // Fallback to clipboard if sharing fails
          document.execCommand('copy', false, shortUrl);
          alert('Share link copied to clipboard!');
        });
      } else {
        // Fallback for browsers that don't support Web Share API
        document.execCommand('copy', false, shortUrl); // Use execCommand for clipboard
        alert('Share link copied to clipboard!');
      }
    }

    async function getShortUrl(question, answer, league, ruleId) {
      try {
        const resp = await fetch('/api/shorten', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rule_id: ruleId || '',
            rulebook: league || '',
            source_text: answer || '',
            question: question || ''
          })
        });
        const data = await resp.json();
        return (resp.ok && data.short_url) ? data.short_url : null;
      } catch (err) {
        console.error('Error creating short link:', err);
        return null;
      }
    }

    // --- VOICE RECOGNITION ---
    if (speechSupported) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.lang = "en-US";
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      micButton.addEventListener("click", () => {
        try {
          console.log("Starting voice recognition...");
          isListening = true;
          micButton.textContent = "🎤 Listening...";
          micButton.disabled = true;
          submitButton.disabled = true;
          questionInput.disabled = true;

          clearTimeout(voiceSafetyTimer);
          voiceSafetyTimer = setTimeout(() => {
            console.warn("Voice recognition safety timeout — resetting controls");
            try { recognition.stop(); } catch (_) { /* ignore */ }
            resetVoiceUi();
          }, VOICE_LISTEN_TIMEOUT_MS);

          recognition.start();
        } catch (err) {
          console.error("Voice recognition error:", err);
          resetVoiceUi();
        }
      });

      recognition.onresult = (event) => {
        console.log("Voice recognition result:", event.results);

        if (event.results[0].isFinal) {
          const transcript = event.results[0][0].transcript;
          console.log("Final transcript:", transcript);
          questionInput.value = transcript;
          resetVoiceUi();
          updateSubmitButtonState();
          handleNewQuestion(transcript);
        }
      };

      recognition.onstart = () => {
        console.log("Voice recognition started");
      };

      recognition.onend = () => {
        console.log("Voice recognition ended");
        resetVoiceUi();
      };

      recognition.onerror = (event) => {
        console.error("Voice recognition error:", event.error, event);
        resetVoiceUi();
      };
    } else {
      console.log("Speech recognition not supported");
      micButton.disabled = true;
      micButton.textContent = "🎤 Mic not supported";
    }

    // Initial state
    resetConversation();

// --- PWA ---
// Register service worker for PWA functionality
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/rulebook/service-worker.js')
          .then((registration) => {
            console.log('Service Worker registered successfully:', registration.scope);
            
            // Check for updates
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing;
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  // New version available
                  if (confirm('A new version of HeyBLU.AI is available. Would you like to update?')) {
                    newWorker.postMessage({ type: 'SKIP_WAITING' });
                    window.location.reload();
                  }
                }
              });
            });
          })
          .catch((error) => {
            console.error('Service Worker registration failed:', error);
          });
      });
    }

    // Handle beforeinstallprompt event for install banner
    let deferredPrompt;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      
      // Show custom install button
      showInstallButton();
      console.log('Install prompt ready');
    });

    // Debug PWA requirements
    window.addEventListener('load', () => {
      console.log('PWA Debug Info:');
      console.log('- HTTPS:', window.location.protocol === 'https:');
      console.log('- Service Worker:', 'serviceWorker' in navigator);
      console.log('- Manifest:', document.querySelector('link[rel="manifest"]')?.href);
      console.log('- Apple Touch Icons:', document.querySelectorAll('link[rel="apple-touch-icon"]').length);
      
      // Check if already installed
      if (window.matchMedia('(display-mode: standalone)').matches) {
        console.log('- Already running as PWA');
      } else {
        console.log('- Running in browser');
      }
      
      // iOS-specific install guidance
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        console.log('- iOS detected');
        showIOSInstallInstructions();
      }
    });

    function showIOSInstallInstructions() {
      // Check if instructions already shown
      if (localStorage.getItem('ios-install-shown')) return;
      
      const instructions = document.createElement('div');
      instructions.id = 'ios-install-instructions';
      instructions.innerHTML = `
        <div style="
          position: fixed;
          top: 20px;
          left: 20px;
          right: 20px;
          background: #2563eb;
          color: white;
          padding: 15px;
          border-radius: 10px;
          z-index: 1001;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          font-size: 14px;
          line-height: 1.4;
        ">
          <strong>📱 Install HeyBLU App:</strong><br>
          Tap the <strong>Share</strong> button <span style="font-size: 18px;">📤</span> then select <strong>"Add to Home Screen"</strong>
          <button onclick="this.parentElement.remove(); localStorage.setItem('ios-install-shown', 'true');" style="
            position: absolute;
            top: 5px;
            right: 10px;
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
          ">×</button>
        </div>
      `;
      
      document.body.appendChild(instructions);
      
      // Auto-hide after 15 seconds
      setTimeout(() => {
        if (instructions.parentNode) {
          instructions.remove();
          localStorage.setItem('ios-install-shown', 'true');
        }
      }, 15000);
    }

    function showInstallButton() {
      // Check if install button already exists
      if (document.getElementById('install-button')) return;
      
      const installButton = document.createElement('button');
      installButton.id = 'install-button';
      installButton.innerHTML = '📱 Install HeyBLU App';
      installButton.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #2563eb;
        color: white;
        border: none;
        padding: 12px 20px;
        border-radius: 25px;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        z-index: 1000;
        transition: all 0.2s;
      `;
      
      installButton.addEventListener('click', () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
              console.log('User accepted the install prompt');
            } else {
              console.log('User dismissed the install prompt');
            }
            deferredPrompt = null;
            installButton.remove();
          });
        }
      });
      
      document.body.appendChild(installButton);
      
      // Auto-hide after 10 seconds
      setTimeout(() => {
        if (installButton.parentNode) {
          installButton.remove();
        }
      }, 10000);
    }

    // Handle app installed event
    window.addEventListener('appinstalled', (evt) => {
      console.log('HeyBLU.AI was installed');
      deferredPrompt = null;
    });

})();
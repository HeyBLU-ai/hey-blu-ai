/**
 * Judgment Matrices — static configuration for the Active Interviewer.
 *
 * Each matrix represents a category of baseball play that requires
 * circumstantial information before the rules engine can make an accurate ruling.
 *
 * Schema per matrix:
 *   id          — machine key, returned in every State B response
 *   label       — human-readable category name shown in the UI
 *   triggers    — keywords for fast pre-screening (avoids LLM classifier call)
 *   questions   — ordered list of diagnostic questions
 *     id              — machine key for the answer
 *     text            — exact text shown to the umpire
 *     type            — 'binary' (yes/no) | 'select' (pick one)
 *     options         — array of possible answers
 *     depends_on      — null | { other_question_id: 'required_answer_value' }
 *                       if condition is not met, question is skipped
 *     context_template— maps each possible answer to a plain-English ruling context string
 *   ruling_hint — appended to the RAG prompt to guide the final synthesis
 *
 * To add a new matrix: append an entry here. No other code changes needed.
 */

export const JUDGMENT_MATRICES = [

  // ── 1. Runner–Fielder Collision / Obstruction ─────────────────────────────
  {
    id:       'runner_fielder_collision',
    label:    'Runner–Fielder Collision / Obstruction',
    triggers: [
      'collision', 'collide', 'ran into', 'crashed into', 'crashed', 'contact',
      'obstruction', 'obstruct', 'block', 'blocked', 'blocking', 'interfere',
      'interference', 'run over', 'bowled over', 'plowed', 'plow',
      'standing in front', 'in front of the base', 'in the way', 'in his way',
      'in the path', 'blocked the path', 'blocked his path', 'couldn\'t reach',
      'could not reach', 'cut off', 'impede', 'impeded',
    ],
    questions: [
      {
        id:       'fielder_had_possession',
        text:     'Did the fielder have possession of the ball when the contact occurred?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: null,
        context_template: {
          yes: 'The fielder HAD possession of the ball at the moment of contact.',
          no:  'The fielder did NOT have possession of the ball at the moment of contact.',
        },
      },
      {
        id:       'runner_deviated',
        text:     'Did the runner deviate from the direct base path to initiate contact (rather than sliding or going around)?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: { fielder_had_possession: 'yes' },
        context_template: {
          yes: 'The runner deliberately deviated from the base path to initiate contact with the fielder.',
          no:  'The runner stayed on the base path and did not deliberately initiate contact.',
        },
      },
      {
        id:       'fielder_blocking_path',
        text:     'Was the fielder blocking the base path or home plate without possession of the ball (and not in the act of fielding a thrown ball)?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: { fielder_had_possession: 'no' },
        context_template: {
          yes: 'The fielder WAS blocking the base path or home plate without possession of the ball.',
          no:  'The fielder was not blocking the base path (they were in a legitimate fielding position or reacting to an incoming throw).',
        },
      },
    ],
    ruling_hint:
      'If the fielder HAD possession AND the runner deviated → runner interference (runner is out). ' +
      'If the fielder had NO possession AND was blocking → obstruction (award appropriate base). ' +
      'If the fielder had possession and the runner did NOT deviate → incidental contact, generally no call. ' +
      'At home plate, special collision rules under Rule 6.01(i) apply.',
  },

  // ── 2. Infield Fly Rule ───────────────────────────────────────────────────
  {
    id:       'infield_fly_rule',
    label:    'Infield Fly Rule',
    triggers: [
      'infield fly', 'infield fly rule', 'popup', 'pop up', 'pop-up', 'pop fly',
      'automatic out', 'batter automatically', 'runners on first and second',
      'bases loaded', 'runners on base popup',
    ],
    questions: [
      {
        id:       'outs_at_time',
        text:     'How many outs were there when the ball was hit?',
        type:     'select',
        options:  ['0 outs', '1 out', '2 outs'],
        depends_on: null,
        context_template: {
          '0 outs': 'There were 0 outs when the ball was hit.',
          '1 out':  'There was 1 out when the ball was hit.',
          '2 outs': 'There were 2 outs when the ball was hit.',
        },
      },
      {
        id:       'base_occupancy',
        text:     'Which bases were occupied at the time of the pitch?',
        type:     'select',
        options:  ['1st and 2nd', 'Bases loaded', '1st only', '2nd only', 'Other'],
        depends_on: { outs_at_time: '0 outs' },  // only relevant with fewer than 2 outs
        context_template: {
          '1st and 2nd':   'First and second bases were occupied (runners on 1st and 2nd).',
          'Bases loaded':  'Bases were loaded (runners on 1st, 2nd, and 3rd).',
          '1st only':      'Only first base was occupied.',
          '2nd only':      'Only second base was occupied.',
          'Other':         'An atypical base occupancy situation was present.',
        },
      },
      {
        id:       'base_occupancy_1out',
        text:     'Which bases were occupied at the time of the pitch?',
        type:     'select',
        options:  ['1st and 2nd', 'Bases loaded', '1st only', '2nd only', 'Other'],
        depends_on: { outs_at_time: '1 out' },
        context_template: {
          '1st and 2nd':   'First and second bases were occupied (runners on 1st and 2nd).',
          'Bases loaded':  'Bases were loaded (runners on 1st, 2nd, and 3rd).',
          '1st only':      'Only first base was occupied.',
          '2nd only':      'Only second base was occupied.',
          'Other':         'An atypical base occupancy situation was present.',
        },
      },
      {
        id:       'ball_type',
        text:     'Was the ball a clear popup or fly ball (not a line drive, bunt, or hard-hit ball)?',
        type:     'binary',
        options:  ['Yes, clear popup/fly ball', 'No, it was a line drive or similar'],
        depends_on: null,
        context_template: {
          'yes, clear popup/fly ball':               'The ball was a clear popup or fly ball (not a line drive or bunt).',
          'no, it was a line drive or similar':      'The ball was a line drive or hard-hit ball, not a popup.',
        },
      },
      {
        id:       'ordinary_effort',
        text:     'Could an infielder have caught the ball with ordinary effort?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: null,
        context_template: {
          yes: 'The ball could have been caught by an infielder with ordinary effort.',
          no:  'The ball required extraordinary effort or was beyond ordinary infielder reach.',
        },
      },
    ],
    ruling_hint:
      'The Infield Fly Rule applies ONLY when: fewer than 2 outs, runners on 1st and 2nd OR bases loaded, ' +
      'and a fair popup that can be caught with ordinary effort by an infielder. ' +
      'If these conditions are not all met, the infield fly rule does NOT apply. ' +
      'If it DOES apply, the batter is automatically out regardless of whether the ball is caught or dropped.',
  },

  // ── 3. Dropped Third Strike ───────────────────────────────────────────────
  {
    id:       'dropped_third_strike',
    label:    'Dropped Third Strike',
    triggers: [
      'dropped third strike', 'dropped 3rd strike', 'passed ball strike', 'uncaught third',
      'third strike not caught', 'batter run on strike', 'can the batter run',
      'batter run after strikeout', 'strikeout run to first',
    ],
    questions: [
      {
        id:       'first_base_occupied',
        text:     'Was first base occupied at the time of the pitch?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: null,
        context_template: {
          yes: 'First base WAS occupied at the time of the pitch.',
          no:  'First base was NOT occupied at the time of the pitch.',
        },
      },
      {
        id:       'outs_count',
        text:     'How many outs were there at the time of the pitch?',
        type:     'select',
        options:  ['0 outs', '1 out', '2 outs'],
        depends_on: null,
        context_template: {
          '0 outs': 'There were 0 outs.',
          '1 out':  'There was 1 out.',
          '2 outs': 'There were 2 outs.',
        },
      },
    ],
    ruling_hint:
      'Batter-runner may advance to first on a dropped third strike ONLY if: ' +
      '(a) first base is NOT occupied, OR (b) first base IS occupied but there are already 2 outs. ' +
      'If first base is occupied with fewer than 2 outs, the batter is out and cannot run even if the catcher drops the ball.',
  },

  // ── 4. Check Swing + Hit by Pitch ────────────────────────────────────────
  {
    id:       'check_swing_hbp',
    label:    'Check Swing / Hit-by-Pitch Ruling',
    triggers: [
      'check swing', 'checked swing', 'half swing', 'started to swing', 'held up',
      'hit by pitch', 'hit by ball', 'hbp', 'ball hit batter', 'batter hit',
      'pitch hit him', 'struck by pitch', 'plunked', 'got hit', 'ball hit the batter',
    ],
    questions: [
      {
        id:       'play_type',
        text:     'What is the primary situation you need to rule on?',
        type:     'select',
        options:  ['Batter was hit by a pitch (HBP) — ruling on award', 'Batter checked swing — ruling on strike or no pitch'],
        depends_on: null,
        context_template: {
          'batter was hit by a pitch (hbp) — ruling on award': 'This is a Hit-by-Pitch (HBP) ruling.',
          'batter checked swing — ruling on strike or no pitch': 'This is a checked-swing ruling.',
        },
      },
      {
        id:       'ball_in_zone',
        text:     'Was the pitch in the strike zone when it struck the batter?',
        type:     'binary',
        options:  ['Yes', 'No', 'Unclear'],
        depends_on: { play_type: 'batter was hit by a pitch (hbp) — ruling on award' },
        context_template: {
          yes:     'The ball WAS in the strike zone when it struck the batter.',
          no:      'The ball was NOT in the strike zone when it struck the batter.',
          unclear: 'It is unclear whether the ball was in the strike zone.',
        },
      },
      {
        id:       'batter_avoided',
        text:     'Did the batter make any attempt to avoid the pitch?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: { play_type: 'batter was hit by a pitch (hbp) — ruling on award' },
        context_template: {
          yes: 'The batter DID attempt to avoid the pitch.',
          no:  'The batter made NO attempt to avoid the pitch.',
        },
      },
      {
        id:       'swing_broke_plane',
        text:     "Did the batter's wrists roll over, or did the bat head break the plane of home plate?",
        type:     'binary',
        options:  ['Yes — wrists rolled / bat broke plane', 'No — batter held back'],
        depends_on: { play_type: 'batter checked swing — ruling on strike or no pitch' },
        context_template: {
          'yes — wrists rolled / bat broke plane': 'The batter\'s wrists rolled over and/or the bat head broke the plane of home plate (strike).',
          'no — batter held back':                 'The batter successfully held back — the bat did not break the plane.',
        },
      },
    ],
    ruling_hint:
      'HBP award: batter gets first base unless the ball is in the strike zone OR the batter made no attempt to avoid it. ' +
      'Check swing: it is a strike if the batter broke the plane of home plate with the bat or the wrists clearly rolled over. ' +
      'The plate umpire may request help from the base umpire on check swings.',
  },

  // ── 5. Fair / Foul Ball Determination ────────────────────────────────────
  {
    id:       'fair_foul_ball',
    label:    'Fair/Foul Ball Near the Base Lines',
    triggers: [
      'fair or foul', 'fair ball', 'foul ball', 'down the line', 'foul line',
      'spun fair', 'spun foul', 'rolled fair', 'rolled foul',
      'bounced over', 'past the bag', 'on the line', 'chalk',
    ],
    questions: [
      {
        id:       'ball_position_at_bag',
        text:     'Where was the ball in relation to first or third base when a fielder touched it, or when it came to rest?',
        type:     'select',
        options:  [
          'In fair territory when it crossed or was touched near the bag',
          'In foul territory when it crossed or was touched near the bag',
          'Ball passed the base without being touched — where did it stop?',
        ],
        depends_on: null,
        context_template: {
          'in fair territory when it crossed or was touched near the bag':
            'The ball was in FAIR territory when it crossed/was touched near the base.',
          'in foul territory when it crossed or was touched near the bag':
            'The ball was in FOUL territory when it crossed/was touched near the base.',
          'ball passed the base without being touched — where did it stop?':
            'The ball passed the base without being touched.',
        },
      },
      {
        id:       'ball_stop_location',
        text:     'After passing the base untouched, where did the ball come to rest or get touched by a fielder?',
        type:     'select',
        options:  ['Fair territory (between the bases, in the outfield)', 'Foul territory'],
        depends_on: { ball_position_at_bag: 'ball passed the base without being touched — where did it stop?' },
        context_template: {
          'fair territory (between the bases, in the outfield)': 'The ball came to rest or was touched in FAIR territory.',
          'foul territory': 'The ball came to rest or was touched in FOUL territory.',
        },
      },
    ],
    ruling_hint:
      'A batted ball is fair or foul based on its position when it passes or is touched near first/third base. ' +
      'A ball that rolls in fair territory past the base is fair even if it rolls foul afterward. ' +
      'A ball touched by a fielder while in foul territory (in front of or beyond the bag) is foul.',
  },

  // ── 6. Tag / Secure Possession (ball dislodged during tag) ─────────────────
  {
    id:       'tag_secure_possession',
    label:    'Tag Play — Secure Possession / Dislodged Ball',
    triggers: [
      'dislodged', 'ball gets dislodged', 'ball was dislodged', 'pop out of',
      'popped out of', 'pop out of the glove', 'popped out of the glove',
      'pop out of mitt', 'popped out of mitt', 'bobble', 'juggle', 'juggled',
      're-catch', 're-caught', 'recatch', 'recaught', 're catches',
      'ball stays in the air', 'stays in the air', 'lose possession',
      'loses possession', 'lost possession', 'dropped after the tag',
      'dropped after tag', 'secure possession', 'voluntary release',
      'loose ball after tag', 'ball comes loose', 'comes out of the glove',
      'comes out of the mitt', 'comes out of glove',
    ],
    questions: [
      {
        id:       'play_type_force_or_tag',
        text:     'Was this a tag play on a non-forced runner, or a force play at a base?',
        type:     'select',
        options:  ['Tag play — runner was not forced', 'Force play — runner was forced to that base'],
        depends_on: null,
        context_template: {
          'tag play — runner was not forced':              'This was a TAG play on a non-forced runner (tag required, not just touching the base).',
          'force play — runner was forced to that base':   'This was a FORCE play — the runner was forced to advance to that base.',
        },
      },
      {
        id:       'tag_before_dislodged',
        text:     'Before the ball was dislodged, had the fielder already touched the runner with the ball (or with the gloved hand holding the ball)?',
        type:     'binary',
        options:  ['Yes', 'No', 'Unclear'],
        depends_on: { play_type_force_or_tag: 'tag play — runner was not forced' },
        context_template: {
          yes:     'The fielder HAD already touched the runner with the ball (or gloved hand holding the ball) BEFORE the ball was dislodged.',
          no:      'The fielder had NOT yet touched the runner before the ball was dislodged.',
          unclear: 'It is unclear whether the tag contact occurred before the ball was dislodged.',
        },
      },
      {
        id:       'runner_on_base_before_recatch',
        text:     'When the fielder re-caught the ball, had the runner already touched the base?',
        type:     'binary',
        options:  ['Yes — runner reached the base first', 'No — fielder had the ball again first'],
        depends_on: { play_type_force_or_tag: 'tag play — runner was not forced' },
        context_template: {
          'yes — runner reached the base first':     'When the fielder re-caught the ball, the runner had ALREADY touched the base.',
          'no — fielder had the ball again first':   'When the fielder re-caught the ball, the runner had NOT yet touched the base.',
        },
      },
    ],
    ruling_hint:
      'A tag out requires the fielder to touch the runner with the ball or with the gloved hand holding the ball. ' +
      'If the ball is dislodged from the glove AFTER secure possession is established and the tag is applied, the runner is generally OUT. ' +
      'If possession was NOT secure at the moment of contact (ball already loose, bobble, or juggling), the tag may NOT be valid — runner may be SAFE. ' +
      'A voluntary release to transfer the ball is not a loss of possession; an involuntary dislodgement before the tag is complete may invalidate the out. ' +
      'If the runner reached the base before the fielder regained possession and completed a valid tag, the runner is SAFE.',
  },

  // ── 7. Appeal Play ────────────────────────────────────────────────────────
  {
    id:       'appeal_play',
    label:    'Appeal Play Procedure',
    triggers: [
      'appeal', 'missed base', 'left base early', 'failed to tag up',
      'batting out of turn', 'overran', 'overslid', 'tag up',
      'did not retouch', 'must appeal', 'proper appeal',
    ],
    questions: [
      {
        id:       'appeal_type',
        text:     'What is the specific infraction being appealed?',
        type:     'select',
        options:  [
          'Runner missed a base while advancing',
          'Runner failed to retouch base after a caught fly ball (failed to tag up)',
          'Runner left base before a fly ball was caught (left early)',
          'Batter hit out of turn',
          'Runner overran first base and went toward second',
        ],
        depends_on: null,
        context_template: {
          'runner missed a base while advancing':            'The appeal is for a runner missing a base while advancing.',
          'runner failed to retouch base after a caught fly ball (failed to tag up)': 'The appeal is for failing to retouch a base after a caught fly ball.',
          'runner left base before a fly ball was caught (left early)': 'The appeal is for leaving a base before a fly ball was caught.',
          'batter hit out of turn':                         'The appeal is for batting out of turn.',
          'runner overran first base and went toward second': 'The appeal involves a runner overrunning first base.',
        },
      },
      {
        id:       'ball_live',
        text:     'Was the ball live (in play) when the appeal was made?',
        type:     'binary',
        options:  ['Yes, ball was live', 'No, time was called'],
        depends_on: null,
        context_template: {
          'yes, ball was live':   'The ball WAS live when the appeal was made.',
          'no, time was called':  'Time had been called — the ball was dead when the appeal was made.',
        },
      },
      {
        id:       'appeal_before_next_pitch',
        text:     'Was the appeal made before the next pitch (or before a play or attempted play)?',
        type:     'binary',
        options:  ['Yes', 'No — the next pitch had already been delivered'],
        depends_on: null,
        context_template: {
          yes:                                      'The appeal was made BEFORE the next pitch.',
          'no — the next pitch had already been delivered': 'The next pitch had already been delivered before the appeal was made.',
        },
      },
    ],
    ruling_hint:
      'A valid appeal requires: (1) the ball must be live, (2) the fielder must touch the missed/abandoned base while possessing the ball (or tag the runner), ' +
      '(3) the appeal must be made before the next pitch (or before any other play/attempted play). ' +
      'An appeal after the next pitch has been delivered is invalid. ' +
      'Batting out of turn appeals must be made before the next pitch to the following batter.',
  },

  // ── 8. Force Play vs. Tag Required ───────────────────────────────────────
  {
    id:       'force_vs_tag',
    label:    'Force Play vs. Tag Required',
    triggers: [
      'force out', 'force play', 'forced', 'has to tag', 'need to tag', 'must tag',
      'tag the runner', 'does he have to tag', 'is it a force',
      'force was removed', 'force removed',
    ],
    questions: [
      {
        id:       'runner_forced',
        text:     'Was the runner being forced to advance because the batter became a runner (forcing every preceding runner to the next base)?',
        type:     'binary',
        options:  ['Yes', 'No'],
        depends_on: null,
        context_template: {
          yes: 'The runner WAS forced to advance (batter reached base and runners were forced).',
          no:  'The runner was NOT forced to advance — they were running voluntarily.',
        },
      },
      {
        id:       'force_removed',
        text:     'Was the force play subsequently removed? (e.g., did a following runner get put out before reaching the base, which would un-force the lead runner?)',
        type:     'binary',
        options:  ['Yes, the force was removed', 'No, the force was still in effect'],
        depends_on: { runner_forced: 'yes' },
        context_template: {
          'yes, the force was removed':      'The force was subsequently REMOVED (a following runner was retired, eliminating the force on the lead runner).',
          'no, the force was still in effect': 'The force was still in effect at the time of the play.',
        },
      },
    ],
    ruling_hint:
      'A force play exists when a runner is legally forced to the next base because the batter became a runner. ' +
      'On a force play, the fielder only needs to touch the base while possessing the ball — no tag is required. ' +
      'If the force is removed (the following runner is put out), the lead runner is no longer forced and MUST be tagged. ' +
      'If the runner retreats toward the previous base after touching the forced base, the force is reinstated.',
  },

];

/**
 * Returns the matrix object for a given ID, or null if not found.
 */
export function findMatrix(matrixId) {
  return JUDGMENT_MATRICES.find(m => m.id === matrixId) ?? null;
}

/**
 * Determines the next unanswered, applicable question for a matrix.
 * Returns null when all applicable questions have been answered (interview complete).
 *
 * "Applicable" means the question's depends_on condition (if any) is satisfied
 * by the current answers. Conditional questions whose condition is NOT met are
 * skipped — they are not relevant to this specific play.
 */
export function getNextQuestion(matrix, answers = {}) {
  for (const q of matrix.questions) {
    if (q.id in answers) continue;               // already answered

    if (q.depends_on !== null) {
      const conditionMet = Object.entries(q.depends_on).every(
        ([depId, depVal]) => {
          const givenAnswer = (answers[depId] ?? '').toLowerCase();
          return givenAnswer === depVal.toLowerCase();
        },
      );
      if (!conditionMet) continue;               // condition not met — skip
    }

    return q;                                    // first unanswered applicable question
  }
  return null;                                   // all applicable questions answered
}

/**
 * Builds a plain-English ruling context string from the collected answers.
 * This string is injected into the RAG prompt to give the AI the circumstantial
 * evidence it could not derive from the question text alone.
 */
export function buildRulingContext(matrix, answers = {}) {
  const lines = [];

  for (const q of matrix.questions) {
    const answer = answers[q.id];
    if (answer === undefined) continue;

    const template = q.context_template?.[answer.toLowerCase()];
    if (template) lines.push(template);
  }

  const context = lines.join(' ');
  const hint    = matrix.ruling_hint ?? '';

  return [
    `PLAY CONTEXT (${matrix.label}):`,
    context,
    hint ? `\nRULING GUIDANCE: ${hint}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Fast keyword pre-screen. Returns the first matrix whose trigger keywords
 * appear in the question text. Returns null if no match (question is likely factual).
 *
 * This runs BEFORE the LLM classifier call, eliminating it for the majority
 * of questions that are clearly factual (distances, pitch counts, equipment specs).
 */
/**
 * Prefixes that indicate a definitional / explanatory question.
 * These always ask "what is the rule" — not "how should I rule on this play".
 * They must be answered factually from the rulebook (RAG), never routed to
 * an interview matrix, even if the question contains a matrix trigger keyword
 * (e.g. "what is the infield fly rule?" contains "infield fly rule" but is
 * not a judgment-call play).
 */
const DEFINITIONAL_PREFIXES = [
  'what is ', "what's ", 'what are ',
  'what happens ', 'what happen ',
  'what is the rule when ', 'what is the ruling when ',
  'define ', 'explain ', 'describe ',
  'how does ', 'how do ', 'how is ',
  'tell me about ',
  'what does ', 'what do ',
];

export function prescreenForMatrix(question) {
  const q = question.toLowerCase().trim();

  // Definitional questions are always factual — skip trigger matching entirely.
  if (DEFINITIONAL_PREFIXES.some(p => q.startsWith(p))) return null;

  // Prefer the longest matching trigger across all matrices (most specific wins).
  let best = null;
  for (const matrix of JUDGMENT_MATRICES) {
    for (const trigger of matrix.triggers) {
      const t = trigger.toLowerCase();
      if (q.includes(t) && (!best || t.length > best.trigger.length)) {
        best = { matrix, trigger: t };
      }
    }
  }
  return best?.matrix ?? null;
}

/**
 * Returns true when the umpire already described a specific play sequence in
 * enough detail that an interview would ask redundant questions — route
 * directly to RAG instead.
 *
 * Example: "ball gets dislodged, stays in the air, fielder re-catches, runner
 * reaches the base — safe or out?"
 */
export function questionHasDetailedPlayContext(question) {
  const q = (question ?? '').trim();
  if (q.length < 70) return false;

  const signals = [
    /\bsafe or out\b/i,
    /\bout or safe\b/i,
    /ball gets dislodged|ball was dislodged|dislodged|pop(ped)? out of (the )?(glove|mitt)/i,
    /re-?catch|re-?caught|stays in the air|bobble|juggle/i,
    /\bthen\b.{0,40}\brunner\b/i,
    /by then the runner|runner (is|was|reached|on) (the |)base/i,
    /fielder tags|tagged the runner|applied the tag/i,
  ];

  const hits = signals.filter(re => re.test(q)).length;
  return hits >= 2;
}

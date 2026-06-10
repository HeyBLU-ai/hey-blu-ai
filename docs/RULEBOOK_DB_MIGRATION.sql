-- ============================================================
-- HeyBLU Rulebook — Supabase / Postgres Migration
-- Version: 2 (Option B: sport column on rules table)
--
-- Run order: execute the entire file in the Supabase SQL editor.
-- Requires: pgvector extension (enabled by default on Supabase).
-- ============================================================


-- ============================================================
-- PART 1: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================
-- PART 2: DDL
-- ============================================================

CREATE TABLE leagues (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT        NOT NULL UNIQUE,
    name             TEXT        NOT NULL,
    parent_league_id UUID        REFERENCES leagues(id) ON DELETE SET NULL,
    is_foundation    BOOLEAN     NOT NULL DEFAULT FALSE,
    effective_date   DATE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  leagues                   IS 'Foundation ORBs and local leagues. Local leagues point to their parent via parent_league_id.';
COMMENT ON COLUMN leagues.slug              IS 'Machine key used in API requests and ask.js league whitelist.';
COMMENT ON COLUMN leagues.parent_league_id  IS 'NULL for foundation leagues (MLB, LL, USSSA). Non-null for local leagues.';
COMMENT ON COLUMN leagues.is_foundation     IS 'TRUE for ORB/foundation leagues that serve as fallback sources.';


CREATE TABLE rules (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    league_id         UUID        NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    rule_number       TEXT        NOT NULL,
    title             TEXT        NOT NULL,
    body              TEXT        NOT NULL,
    sport             TEXT        NOT NULL DEFAULT 'baseball',
    overrides_rule_id UUID        REFERENCES rules(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (league_id, rule_number, sport)
);

COMMENT ON TABLE  rules                    IS 'One row per rule chunk per sport. The sport column disambiguates rules that share a rule_number across baseball and softball (e.g. LL 1.10).';
COMMENT ON COLUMN rules.rule_number        IS 'Official rule number as printed in the rulebook. Unique within (league, sport).';
COMMENT ON COLUMN rules.body               IS 'Full rule text used for display and embedding input.';
COMMENT ON COLUMN rules.sport              IS 'Discriminator: baseball | softball | both. Defaults to baseball.';
COMMENT ON COLUMN rules.overrides_rule_id  IS 'Points to the parent-league rule this row supersedes. NULL for additive rules.';


CREATE TABLE rule_embeddings (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id    UUID         NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    model      TEXT         NOT NULL DEFAULT 'text-embedding-3-small',
    embedding  vector(1536) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (rule_id, model)
);

COMMENT ON TABLE  rule_embeddings           IS 'Vector embeddings per rule per model. Separate table so re-embedding does not touch rules rows.';
COMMENT ON COLUMN rule_embeddings.model     IS 'OpenAI model name that produced this embedding.';
COMMENT ON COLUMN rule_embeddings.embedding IS '1536-dim vector for text-embedding-3-small; change to 3072 for text-embedding-3-large.';


CREATE TABLE IF NOT EXISTS question_logs (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    question   TEXT        NOT NULL,
    answer     TEXT,
    rule_ref   TEXT,
    rulebook   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE question_logs IS 'Existing log table. rulebook column maps to leagues.slug in Phase 2 API rewrite.';


-- ============================================================
-- PART 3: INDEXES
-- ============================================================

CREATE INDEX idx_rules_league_id          ON rules (league_id);
CREATE INDEX idx_rules_sport              ON rules (sport);
CREATE INDEX idx_rule_embeddings_rule_id  ON rule_embeddings (rule_id);

CREATE INDEX idx_leagues_foundation
    ON leagues (id)
    WHERE is_foundation = TRUE;

CREATE INDEX idx_rule_embeddings_hnsw
    ON rule_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);


-- ============================================================
-- PART 4: SEED — LEAGUES
-- ============================================================

-- Foundation leagues first (no parent dependency)
INSERT INTO leagues (slug, name, is_foundation, effective_date) VALUES
    ('mlb',           'MLB Official Rules of Baseball',           TRUE, '2024-01-01'),
    ('little-league', 'Little League International',              TRUE, '2024-01-01'),
    ('usssa',         'USSSA Baseball',                           TRUE, '2024-01-01');

-- Local leagues (depend on foundation rows above)
INSERT INTO leagues (slug, name, is_foundation, parent_league_id, effective_date)
SELECT 'mill-valley-aaa', 'Mill Valley Little League AAA', FALSE,
       (SELECT id FROM leagues WHERE slug = 'little-league'), '2024-01-01'::DATE
UNION ALL
SELECT 'bamsbl', 'Bay Area Men''s Senior Baseball League', FALSE,
       (SELECT id FROM leagues WHERE slug = 'mlb'), '2024-01-01'::DATE;


-- ============================================================
-- PART 5: SEED — RULES
-- Helper: resolve league UUID inline via subquery per block.
-- All body text uses $body$...$body$ dollar-quoting to avoid
-- escaping the extensive single-quotes in legal rule text.
-- ============================================================


-- ------------------------------------------------------------
-- 5A. MLB — 20 rules, all sport = 'baseball'
-- ------------------------------------------------------------

INSERT INTO rules (league_id, rule_number, title, body, sport) VALUES

((SELECT id FROM leagues WHERE slug='mlb'), '5.01', 'Starting the Game ("Play Ball!")', $body$(a) At the time set for beginning the game the players of the home team shall take their defensive positions, the first batter of the visiting team shall take his position in the batter's box, the umpire-in-chief shall call "Play," and the game shall start. [cite: 4154]
(b) After the umpire calls "Play" the ball is alive and in play and remains alive and in play until for legal cause, or at the umpire's call of "Time" suspending play, the ball becomes dead. [cite: 4155]
(c) The pitcher shall deliver the pitch to the batter who may elect to strike the ball, or who may not offer at it, as he chooses. [cite: 4156]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.02', 'Fielding Positions', $body$When the ball is put in play at the start of or during a game, all fielders other than the catcher shall be on fair territory. [cite: 4158]
(a) The catcher shall station himself directly back of the plate. He may leave his position at any time to catch a pitch or make a play except that when the batter is being given an intentional base on balls, the catcher must stand with both feet within the lines of the catcher's box until the ball leaves the pitcher's hand. PENALTY: Balk. [cite: 4159, 4160, 4161]
(b) The pitcher, while in the act of delivering the ball to the batter, shall take his legal position; [cite: 4162]
(c) Infielder Positioning. Any fielder other than the pitcher and the catcher may station himself anywhere in fair territory, except as described below: [cite: 4163, 4164]
(i) At the time the pitcher is on the rubber and begins the natural movement associated with the delivery of the ball to the batter, the defensive team must have a minimum of four players (in addition to the pitcher and the catcher) with both feet completely in front of the outer boundary of the infield dirt; [cite: 4165]
(ii) at the time the pitcher releases the ball for delivery to the batter, the defensive team must have a minimum of four players (in addition to the pitcher and the catcher) with both feet completely in front of the outer boundary of the infield dirt, at least two of which must be positioned with both feet entirely on each side of second base; and [cite: 4168]
(iii) from the time the pitcher releases the ball to deliver the first pitch to the first batter of a half inning, the two infielders on each side of second base may not switch sides or move to a position other than their side of the infield for the entirety of that inning. Notwithstanding the foregoing, any infielder may switch sides, or move to any other position at the time of a substitution for one of the defensive players (other than a pitching change that substitutes the pitcher for a player not already in the game). Any player who legally replaces an infielder during an inning also may not switch sides or move to a position other than their side of the infield from the time the pitcher releases the ball to deliver the first pitch following the substitution to the end of that half inning (except upon the occurrence of a subsequent substitution during that half inning). [cite: 4170, 4171, 4172]
Rule 5.02(c) Comment: Umpires should bear in mind that the purpose of the Infielder Positioning rule is to prevent the defense from having more than two infielders on either side of second base in an effort to anticipate where the batter will hit the ball prior to delivery of the pitch. If, in the judgment of the umpire, any fielder attempts to circumvent the purposes of this Rule 5.02(c), the umpire shall assess the penalty described below. [cite: 4173, 4174]
PENALTY: If the defensive team violates Rule 5.02(c), and the infielder who violated Rule 5.02(c) was the first player to touch the ball after the pitch, the batter is entitled to first base without liability to be put out (provided he advances to and touches first base) and each runner shall advance one base without liability to put out, unless the batter reaches first base on a hit, an error, or otherwise, and all other runners advance at least one base, in which case the play proceeds without reference to the violation. [cite: 4175]
If the defensive team violates Rule 5.02(c) in any other circumstance, the pitch shall be called a "ball" and the ball is dead, unless the batter reaches first base on a hit, an error, a base on balls, a hit batter, or otherwise, and all other runners advance at least one base, in which case the play proceeds without reference to the violation. [cite: 4179]
If any other play follows any violation (e.g., sacrifice fly, sacrifice bunt, etc.), the manager of the offense may advise the plate umpire that he elects to decline the penalty and accept the play. Such election shall be made immediately at the end of the play. [cite: 4180, 4181]
Rule 5.02(c) Penalty Comment: If a penalty of Rule 5.02(c) is called with a play in progress the umpire will allow the play to continue because the manager may elect to take the play. If the batter-runner missed first base, or a runner misses his next base, he shall be considered as having reached the base, as stated in Note of Rule 5.06(b)(3)(D). [cite: 4182, 4183]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.03', 'Base Coaches', $body$(a) The team at bat shall station two base coaches on the field during its time at bat, one near first base and one near third base. [cite: 4185]
(b) Base coaches shall be limited to two in number and shall be in team uniform. [cite: 4186]
(c) Base coaches must remain within the coach's box consistent with this Rule, except that a coach who has a play at his base may leave the coach's box to signal the player to slide, advance or return to a base if the coach does not interfere with the play in any manner. Other than exchanging equipment, all base coaches shall refrain from physically touching base runners, especially when signs are being given. [cite: 4187, 4188]
PENALTY: If a coach has positioned himself closer to home plate than the coach's box or closer to fair territory than the coach's box before a batted ball passes the coach, the umpire shall, upon complaint by the opposing manager, strictly enforce the rule. The umpire shall warn the coach and instruct him to return to the box. [cite: 4189, 4190]
If the coach does not return to the box he shall be removed from the game. In addition, coaches who violate this Rule may be subject to discipline by the Office of the Commissioner. [cite: 4193, 4194]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.04', 'Batting', $body$(a) Batting Order
(1) Each player of the offensive team shall bat in the order that his name appears in his team's batting order. [cite: 4197]
(2) The batting order shall be followed throughout the game unless a player is substituted for another. In that case the substitute shall take the place of the replaced player in the batting order. [cite: 4198, 4199]
(3) The first batter in each inning after the first inning shall be the player whose name follows that of the last player who legally completed his time at bat in the preceding inning. [cite: 4200]
(b) The Batter's Box
(1) The batter shall take his position in the batter's box promptly when it is his time at bat. [cite: 4202]
(2) The batter shall not leave his position in the batter's box after the pitcher comes to Set Position, or starts his windup. [cite: 4203]
PENALTY: If the pitcher pitches, the umpire shall call "Ball" or "Strike," as the case may be. [cite: 4204]
Rule 5.04(b)(2) Comment: The batter leaves the batter's box at the risk of having a strike delivered and called, unless he requests the umpire to call "Time." The batter is not at liberty to step in and out of the batter's box at will. [cite: 4205, 4206]
Once a batter has taken his position in the batter's box, he shall not be permitted to step out of the batter's box in order to use the rosin or the pine tar rag, unless there is a delay in the game action or, in the judgment of the umpires, weather conditions warrant an exception. [cite: 4207]
Umpires will not call "Time" at the request of the batter or any member of his team once the pitcher has started his windup or has come to a set position even though the batter claims "dust in his eyes," "steamed glasses," "didn't get the sign" or for any other cause. [cite: 4208]
Umpires may grant a hitter's request for "Time" once he is in the batter's box, but the umpire should eliminate hitters walking out of the batter's box without reason. If umpires are not lenient, batters will understand that they are in the batter's box and they must remain there until the ball is pitched. See Rule 5.04(b)(4). [cite: 4212, 4213, 4214]
If pitcher delays once the batter is in his box and the umpire feels that the delay is not justified he may allow the batter to step out of the box momentarily. [cite: 4214]
If after the pitcher starts his windup or comes to a "set position" with a runner on, he does not go through with his pitch because the batter has inadvertently caused the pitcher to interrupt his delivery, it shall not be called a balk. [cite: 4215]
Both the pitcher and batter have violated a rule and the umpire shall call time and both the batter and pitcher start over from "scratch." [cite: 4216]
(3) If the batter refuses to take his position in the batter's box during his time at bat, the umpire shall call a strike on the batter. [cite: 4220]
The ball is dead, and no runners may advance. [cite: 4221]
After the penalty, the batter may take his proper position and the regular ball and strike count shall continue. If the batter does not take his proper position before three strikes have been called, the batter shall be declared out. [cite: 4221, 4222]
(4) The Batter's Box Rule
(A) The batter shall keep at least one foot in the batter's box throughout the batter's time at bat, unless one of the following exceptions applies, in which case the batter may leave the batter's box but not the dirt area surrounding home plate: [cite: 4228]
(i) The batter swings at a pitch; [cite: 4231]
(ii) An attempted check swing is appealed to a base umpire; [cite: 4229, 4232]
(iii) The batter is forced off balance or out of the batter's box by a pitch; [cite: 4233, 4240]
(iv) A member of either team requests and is granted "Time"; [cite: 4234, 4241]
(v) A defensive player attempts a play on a runner at any base; [cite: 4235, 4242]
(vi) The batter feints a bunt; [cite: 4236, 4243]
(vii) A wild pitch or passed ball occurs; [cite: 4237, 4244]
(viii) The pitcher leaves the dirt area of the pitching mound after receiving the ball; or [cite: 4238, 4245]
(ix) The catcher leaves the catcher's box to give defensive signals. [cite: 4239, 4246]
(B) The batter may leave the batter's box and the dirt area surrounding home plate when "Time" is called for the purpose or as a result of [cite: 4253]
(i) an injury or potential injury; [cite: 4254]
(ii) making a substitution; or [cite: 4255]
(iii) a conference by either team. [cite: 4256]
(5) The batter's legal position shall be with both feet within the batter's box. [cite: 4258]
APPROVED RULING: The lines defining the box are within the batter's box. [cite: 4259]
(c) Completing Time at Bat
A batter has legally completed his time at bat when he is put out or becomes a runner. [cite: 4261]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.05', 'When the Batter Becomes a Runner', $body$(a) The batter becomes a runner when: [cite: 4263]
(1) He hits a fair ball; [cite: 4264]
(2) The third strike called by the umpire is not caught, providing (1) first base is unoccupied, or (2) first base is occupied with two out; [cite: 4266]
(3) If the pitch touches the ground and bounces through the strike zone it is a "ball." [cite: 4270]
If such a pitch touches the batter, he shall be awarded first base. [cite: 4271]
If the batter swings at such a pitch after two strikes, the ball cannot be caught, for the purposes of Rule 5.05(b) and 5.09(a)(3). [cite: 4272]
(4) A fair ball, after having passed a fielder other than the pitcher, or after having been touched by a fielder, including the pitcher, shall touch an umpire or runner on fair territory; [cite: 4273]
(5) A fair ball passes over a fence or into the stands at a distance from home base of 250 feet or more. [cite: 4274]
Such hit entitles the batter to a home run when he shall have touched all bases legally. [cite: 4275]
A fair fly ball that passes out of the playing field at a point less than 250 feet from home base shall entitle the batter to advance to second base only; [cite: 4276]
(6) A fair ball, after touching the ground, bounds into the stands, or passes through, over or under a fence, or through or under a scoreboard, or through or under shrubbery, or vines on the fence, in which case the batter and the runners shall be entitled to advance two bases; [cite: 4277]
(7) Any fair ball which, either before or after touching the ground, passes through or under a fence, or through or under a scoreboard, or through any opening in the fence or scoreboard, or through or under shrubbery, or vines on the fence, or which sticks in a fence or scoreboard, in which case the batter and the runners shall be entitled to two bases; [cite: 4278]
(8) Any bounding fair ball is deflected by the fielder into the stands, or over or under a fence on fair or foul territory, in which case the batter and all runners shall be entitled to advance two bases; [cite: 4279]
(9) Any fair fly ball is deflected by the fielder into the stands, or over the fence into foul territory, in which case the batter shall be entitled to advance to second base; but if deflected into the stands or over the fence in fair territory, the batter shall be entitled to a home run. However, should such a fair fly be deflected at a point less than 250 feet from home plate, the batter shall be entitled to two bases only. [cite: 4280, 4281, 4282, 4283]
(b) The batter becomes a runner and is entitled to first base without liability to be put out (provided he advances to and touches first base) when: [cite: 4285]
(1) Four "balls" have been called by the umpire; [cite: 4286]
(2) He is touched by a pitched ball which he is not attempting to hit unless (A) The ball is in the strike zone when it touches the batter, or (B) The batter makes no attempt to avoid being touched by the ball; [cite: 4291]
(3) The catcher or any fielder interferes with him. [cite: 4296]
If a play follows the interference, the manager of the offense may advise the plate umpire that he elects to decline the interference penalty and accept the play. Such election shall be made immediately at the end of the play. [cite: 4296, 4297]
However, if the batter reaches first base on a hit, an error, a base on balls, a hit batsman, or otherwise, and all other runners advance at least one base, the play proceeds without reference to the interference. [cite: 4300]
(4) A fair ball touches an umpire or a runner on fair territory before touching a fielder. [cite: 4311]
If a fair ball touches an umpire after having passed a fielder other than the pitcher, or having touched a fielder, including the pitcher, the ball is in play. [cite: 4312]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.06', 'Running the Bases', $body$(a) Occupying the Base
(1) A runner acquires the right to an unoccupied base when he touches it before he is out. [cite: 4317]
He is then entitled to it until he is put out, or forced to vacate it for another runner legally entitled to that base. [cite: 4318]
(2) Two runners may not occupy a base, but if, while the ball is alive, two runners are touching a base, the following runner shall be out when tagged and the preceding runner is entitled to the base, unless Rule 5.06(b)(2) applies. [cite: 4320]
(b) Advancing Bases
(1) In advancing, a runner shall touch first, second, third and home base in order. [cite: 4322]
If forced to return, he shall retouch all bases in reverse order, unless the ball is dead under any provision of Rule 5.06(c). [cite: 4323]
In such cases, the runner may go directly to his original base. [cite: 4324]
(2) If a runner is forced to advance by reason of the batter becoming a runner and two runners are touching a base to which the following runner is forced, the following runner is entitled to the base and the preceding runner shall be out when tagged or when a fielder possesses the ball and touches the base to which such preceding runner is forced. [cite: 4325]
(3) Each runner, other than the batter, may without liability to be put out, advance one base when: [cite: 4326]
(A) There is a balk; [cite: 4327]
(B) The batter's advance without liability to be put out forces the runner to vacate his base, or when the batter hits a fair ball that touches another runner or the umpire before such ball has been touched by, or has passed a fielder, if the runner is forced to advance; [cite: 4328]
(C) A fielder, after catching a fly ball, steps or falls into any out-of-play area; [cite: 4335]
(D) While he is attempting to steal a base, the batter is interfered with by the catcher or any other fielder. [cite: 4337]
(E) A fielder deliberately touches a pitched ball with his cap, mask or any part of his uniform detached from its proper place on his person. [cite: 4339]
The ball is in play, and the award is made from the position of the runner at the time the ball was touched. [cite: 4340]
(4) Each runner including the batter-runner may, without liability to be put out, advance: [cite: 4341]
(A) To home base, scoring a run, if a fair ball goes out of the playing field in flight and he touched all bases legally; [cite: 4344]
or if a fair ball which, in the umpire's judgment, would have gone out of the playing field in flight, is deflected by the act of a fielder in throwing his glove, cap, or any article of his apparel; [cite: 4345]
(B) Three bases, if a fielder deliberately touches a fair ball with his cap, mask or any part of his uniform detached from its proper place on his person. [cite: 4346]
The ball is in play and the batter may advance to home base at his peril; [cite: 4347]
(C) Three bases, if a fielder deliberately throws his glove at and touches a fair ball. [cite: 4348]
The ball is in play and the batter may advance to home base at his peril; [cite: 4349]
(D) Two bases, if a fielder deliberately touches a thrown ball with his cap, mask or any part of his uniform detached from its proper place on his person. [cite: 4350]
The ball is in play; [cite: 4351]
(E) Two bases, if a fielder deliberately throws his glove at and touches a thrown ball. [cite: 4352]
The ball is in play; [cite: 4353]
(F) Two bases, if a fair ball bounces or is deflected into the stands outside the first or third base foul lines; or if it goes through or under a field fence, or through or under a scoreboard, or through or under shrubbery or vines on the fence; or if it sticks in such fence, scoreboard, shrubbery or vines; [cite: 4357, 4358, 4359]
(G) Two bases when, with no spectators on the playing field, a thrown ball goes into the stands, or into a bench (whether or not the ball rebounds into the field), or over or under or through a field fence, or on a slanting part of the screen above the backstop, or remains in the meshes of a wire screen protecting spectators. [cite: 4360, 4361]
The ball is dead. [cite: 4364]
When such wild throw is the first play by an infielder, the umpire, in awarding such bases, shall be governed by the position of the runners at the time the ball was pitched; in all other cases the umpire shall be governed by the position of the runners at the time the wild throw was made; [cite: 4364, 4365]
(H) One base, if a ball, pitched to the batter, or thrown by the pitcher from his position on the pitcher's plate to a base to catch a runner, goes into a stand or a bench, or over or through a field fence or backstop. The ball is dead; [cite: 4381, 4382]
(I) One base, if the batter becomes a runner on Ball Four or Strike Three, when the pitch passes the catcher and lodges in the umpire's mask or paraphernalia. [cite: 4386]
If the batter becomes a runner on a wild pitch which entitles the runners to advance one base, the batter-runner shall be entitled to first base only. [cite: 4389]
(c) Dead Balls
The ball becomes dead and runners advance one base, or return to their bases, without liability to be put out, when: [cite: 4396]
(1) A pitched ball touches a batter, or his clothing, while in his legal batting position; runners, if forced, advance; [cite: 4397]
(2) The plate umpire interferes with the catcher's throw attempting to prevent a stolen base or retire a runner on a pick-off play; runners may not advance. [cite: 4398, 4399]
NOTE: The interference shall be disregarded if the catcher's throw retires the runner. [cite: 4400]
(3) A balk is committed; runners advance; (See Penalty 6.02(a).) [cite: 4405]
(4) A ball is illegally batted; runners return; [cite: 4406]
(5) A foul ball is not caught, in which case runners return to their bases. [cite: 4407]
The umpire-in-chief shall not put the ball in play until all runners have retouched their bases; [cite: 4408]
(6) A fair ball touches a runner or an umpire on fair territory before it touches an infielder including the pitcher, or touches an umpire before it has passed an infielder other than the pitcher; runners advance, if forced. [cite: 4409, 4410]
If a fair ball goes through, or by, an infielder, no other infielder has a chance to make a play on the ball and the ball touches a runner immediately behind the infielder that the ball went through, or by, the ball is in play and the umpire shall not declare the runner out. [cite: 4411]
If a fair ball touches a runner after being deflected by an infielder, the ball is in play and the umpire shall not declare the runner out; [cite: 4412]
(7) A pitched ball lodges in the catcher's mask or paraphernalia, or in or against the umpire's body, mask or paraphernalia, and remains out of play, runners advance one base; [cite: 4415]
(8) Any legal pitch touches a runner trying to score; runners advance. [cite: 4427]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.07', 'Pitching', $body$(a) Legal Pitching Delivery. There are two legal pitching positions, the Windup Position and the Set Position, and either position may be used at any time. Pitchers shall take signs from the catcher while in contact with the pitcher's plate. [cite: 4430, 4431]
(1) The Windup Position. The pitcher shall stand facing the batter, his pivot foot in contact with the pitcher's plate and the other foot free. From this position any natural movement associated with his delivery of the ball to the batter commits him to the pitch without interruption or alteration. He shall not raise either foot from the ground, except that in his actual delivery of the ball to the batter, he may take one step backward, and one step forward with his free foot. [cite: 4442, 4443, 4444]
(2) The Set Position. Set Position shall be indicated by the pitcher when he stands facing the batter with his pivot foot in contact with, and his other foot in front of, the pitcher's plate, holding the ball in both hands in front of his body and coming to a complete stop. [cite: 4454]
From such Set Position he may deliver the ball to the batter, throw to a base or step backward off the pitcher's plate with his pivot foot. Before assuming Set Position, the pitcher may elect to make any natural preliminary motion such as that known as "the stretch." [cite: 4455, 4456]
But if he so elects, he shall come to Set Position before delivering the ball to the batter. After assuming Set Position, any natural motion associated with his delivery of the ball to the batter commits him to the pitch without alteration or interruption. [cite: 4457, 4460]
(b) Warm-Up Pitches. When a pitcher takes his position at the beginning of each inning, or when he relieves another pitcher, he shall be permitted to pitch preparatory pitches to his catcher during which play shall be suspended. [cite: 4472]
A league by its own action may limit the number of preparatory pitches and/or may limit the amount of time such preparatory pitches may consume. [cite: 4475]
If a sudden emergency causes a pitcher to be summoned into the game without any opportunity to warm up, the umpire-in-chief shall allow him as many pitches as the umpire deems necessary. [cite: 4476]
(c) Pitcher Delays. When the bases are unoccupied, the pitcher shall deliver the ball to the batter within 12 seconds after he receives the ball. Each time the pitcher delays the game by violating this rule, the umpire shall call "Ball." [cite: 4478, 4479]
The 12-second timing starts when the pitcher is in possession of the ball and the batter is in the box, alert to the pitcher. The timing stops when the pitcher releases the ball. [cite: 4480, 4481]
(d) Throwing to the Bases. At any time during the pitcher's preliminary movements and until his natural pitching motion commits him to the pitch, he may throw to any base provided he steps directly toward such base before making the throw. [cite: 4486]
(e) Effect of Removing Pivot Foot From Plate. If the pitcher removes his pivot foot from contact with the pitcher's plate by stepping backward with that foot, he thereby becomes an infielder and if he makes a wild throw from that position, it shall be considered the same as a wild throw by any other infielder. [cite: 4490]
(f) Ambidextrous Pitchers. A pitcher must indicate visually to the umpire-in-chief, the batter and any runners the hand with which he intends to pitch, which may be done by wearing his glove on the other hand while touching the pitcher's plate. [cite: 4496]
The pitcher is not permitted to pitch with the other hand until the batter is retired, the batter becomes a runner, the inning ends, the batter is substituted for by a pinch-hitter or the pitcher incurs an injury. [cite: 4497]
In the event a pitcher switches pitching hands during an at-bat because he has suffered an injury, the pitcher may not, for the remainder of the game, pitch with the hand from which he has switched. The pitcher shall not be given the opportunity to throw any preparatory pitches after switching pitching hands. [cite: 4498, 4499]
Any change of pitching hands must be indicated clearly to the umpire-in-chief. [cite: 4500]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.08', 'How a Team Scores', $body$(a) One run shall be scored each time a runner legally advances to and touches first, second, third and home base before three men are put out to end the inning. [cite: 4502]
EXCEPTION: A run is not scored if the runner advances to home base during a play in which the third out is made (1) by the batter-runner before he touches first base; (2) by any runner being forced out; or (3) by a preceding runner who is declared out because he failed to touch one of the bases. [cite: 4503, 4504]
(b) When the winning run is scored in the last half-inning of a regulation game, or in the last half of an extra inning, as the result of a base on balls, hit batter or any other play with the bases full which forces the batter and all other runners to advance without liability of being put out, the umpire shall not declare the game ended until the runner forced to advance from third has touched home base and the batter-runner has touched first base. [cite: 4509]
PENALTY: If the runner on third refuses to advance to and touch home base in a reasonable time, the umpire shall disallow the run, call out the offending player and order the game resumed. [cite: 4512]
If, with two out, the batter-runner refuses to advance to and touch first base, the umpire shall disallow the run, call out the offending player, and order the game resumed. [cite: 4513]
If, before two are out, the batter-runner refuses to advance to and touch first base, the run shall count, but the offending player shall be called out. [cite: 4514]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.09', 'Making an Out', $body$(a) Retiring the Batter. A batter is out when: [cite: 4543, 4544]
(1) His fair or foul fly ball (other than a foul tip) is legally caught by a fielder; [cite: 4545]
(2) A third strike is legally caught by the catcher; [cite: 4567]
(3) A third strike is not caught by the catcher when first base is occupied before two are out; [cite: 4572]
(4) He bunts foul on third strike; [cite: 4573]
(5) An Infield Fly is declared; [cite: 4574]
(6) He attempts to hit a third strike and the ball touches him; [cite: 4575]
(7) His fair ball touches him before touching a fielder. If the batter is in a legal position in the batter's box, see Rule 5.04(b)(5), and, in the umpire's judgment, there was no intention to interfere with the course of the ball, a batted ball that strikes the batter or his bat shall be ruled a foul ball; [cite: 4577, 4578]
(8) After hitting or bunting a fair ball, his bat hits the ball a second time in fair territory. The ball is dead and no runners may advance. If the batter-runner drops his bat and the ball rolls against the bat in fair territory and, in the umpire's judgment, there was no intention to interfere with the course of the ball, the ball is alive and in play. If the batter is in a legal position in the batter's box, see Rule 5.04(b)(5), and, in the umpire's judgment, there was no intention to interfere with the course of the ball, a batted ball that strikes the batter or his bat shall be ruled a foul ball; [cite: 4578, 4579, 4580]
(9) After hitting or bunting a ball that continues to move over foul territory, he intentionally deflects the course of the ball in any manner while running to first base. The ball is dead and no runners may advance; [cite: 4589, 4590]
(10) After a third strike or after he hits a fair ball, he or first base is tagged before he touches first base; [cite: 4591]
(11) In running the last half of the distance from home base to first base, while the ball is being fielded to first base, he runs outside (to the right of) the three-foot line, or inside (to the left of) the foul line and on the infield grass, and in the umpire's judgment in so doing interferes with the fielder taking the throw at first base, in which case the ball is dead; except that he may run outside (to the right of) the three-foot line or inside (to the left of) the foul line and on the infield grass to avoid a fielder attempting to field a batted ball; [cite: 4592, 4593]
(12) An infielder intentionally drops a fair fly ball or line drive, with first, first and second, first and third, or first, second and third base occupied before two are out. The ball is dead and runner or runners shall return to their original base or bases; [cite: 4598, 4599]
(13) A preceding runner shall, in the umpire's judgment, intentionally interfere with a fielder who is attempting to catch a thrown ball or to throw a ball in an attempt to complete any play; [cite: 4601]
(14) With two out, a runner on third base, and two strikes on the batter, the runner attempts to steal home base on a legal pitch and the ball touches the runner in the batter's strike zone. The umpire shall call "Strike Three," the batter is out and the run shall not count; before two are out, the umpire shall call "Strike Three," the ball is dead, and the run counts; [cite: 4604, 4605, 4606]
(15) A member of his team (other than a runner) hinders a fielder's attempt to catch or field a batted ball. See Rule 6.01(b). For interference by a runner, see Rule 5.09(b)(3). [cite: 4607, 4608]
(b) Retiring a Runner. Any runner is out when: [cite: 4611, 4612]
(1) He runs more than three feet away from his base path to avoid being tagged unless his action is to avoid interference with a fielder fielding a batted ball. A runner's base path is established when the tag attempt occurs and is a straight line from the runner to the base he is attempting to reach safely; or [cite: 4613, 4614]
(2) After touching first base, he leaves the base path, obviously abandoning his effort to touch the next base; [cite: 4616]
(3) He intentionally interferes with a thrown ball; or hinders a fielder attempting to make a play on a batted ball (see Rule 6.01(j)); [cite: 4623]
(4) He is tagged, when the ball is alive, while off his base. EXCEPTION: A batter-runner cannot be tagged out after overrunning or oversliding first base if he returns immediately to the base; [cite: 4627, 4628]
(5) He fails to retouch his base after a fair or foul ball is legally caught before he, or his base, is tagged by a fielder. He shall not be called out for failure to retouch his base after the first following pitch, or any play or attempted play. This is an appeal play; [cite: 4631, 4632, 4633]
(6) He or the next base is tagged before he touches the next base, after he has been forced to advance by reason of the batter becoming a runner. However, if a following runner is put out on a force play, the force is removed and the runner must be tagged to be put out. The force is removed as soon as the runner touches the base to which he is forced to advance, and if he overslides or overruns the base, the runner must be tagged to be put out. However, if the forced runner, after touching the next base, retreats for any reason towards the base he had last occupied, the force play is reinstated, and he can again be put out if the defense tags the base to which he is forced; [cite: 4636, 4637, 4638, 4639, 4642]
(7) He is touched by a fair ball in fair territory before the ball has gone through, or by, an infielder and no other infielder has a chance to make a play on the ball. The ball is dead and no runner may score, nor runners advance, except runners forced to advance. EXCEPTION: If a runner is touching his base when touched by an Infield Fly, he is not out, although the batter is out; [cite: 4655, 4656, 4657]
(8) He attempts to score on a play in which the batter interferes with the play at home base before two are out. With two out, the interference puts the batter out and no score counts; [cite: 4664, 4665]
(9) He passes a preceding runner before such runner is out; [cite: 4666]
(10) After he has acquired legal possession of a base, he runs the bases in reverse order for the purpose of confusing the defense or making a travesty of the game. The umpire shall immediately call "Time" and declare the runner out; [cite: 4675, 4676]
(11) He fails to return at once to first base after overrunning or oversliding that base. If he attempts to run to second he is out when tagged. If, after overrunning or oversliding first base he starts toward the dugout, or toward his position, and fails to return to first base at once, he is out, on appeal, when he or the base is tagged; [cite: 4681, 4682, 4683]
(12) In running or sliding for home base, he fails to touch home base and makes no attempt to return to the base, when a fielder holds the ball in his hand, while touching home base, and appeals to the umpire for the decision; [cite: 4685]
(13) A play on him is being made and a member of his team (other than a runner) hinders a fielder's attempt to field a thrown ball. [cite: 4689]
(c) Appeal Plays. Any runner shall be called out, on appeal, when: [cite: 4691, 4692]
(1) After a fly ball is caught, he fails to retouch his original base before he or his original base is tagged; [cite: 4693]
(2) With the ball in play, while advancing or returning to a base, he fails to touch each base in order before he, or a missed base, is tagged; [cite: 4699]
(3) He overruns or overslides first base and fails to return to the base immediately, and he or the base is tagged prior to the runner returning to first base; [cite: 4707]
(4) He fails to touch home base and makes no attempt to return to that base, and home base is tagged. [cite: 4708]
(d) Effect of Preceding Runner's Failure to Touch a Base. Unless two are out, the status of a following runner is not affected by a preceding runner's failure to touch or retouch a base. [cite: 4728]
If, upon appeal, the preceding runner is the third out, no runners following him shall score. [cite: 4729]
If such third out is the result of a force play, neither preceding nor following runners shall score. [cite: 4730]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.10', 'Substitutions and Pitching Changes (Including Visits to the Mound)', $body$(a) A player, or players, may be substituted during a game at any time the ball is dead. [cite: 4737]
A substitute player shall bat in the replaced player's position in the team's batting order. [cite: 4738]
(b) The manager shall immediately notify the umpire-in-chief of any substitution and shall state to the umpire-in-chief the substitute's place in the batting order. [cite: 4739]
(c) The umpire-in-chief, after having been notified, shall immediately announce, or cause to be announced, each substitution. [cite: 4753]
(d) A player once removed from a game shall not re-enter that game. [cite: 4754]
(e) A player whose name is on his team's batting order may not become a substitute runner for another member of his team. [cite: 4769]
(f) The pitcher named in the batting order handed the umpire-in-chief shall pitch to the first batter or any substitute batter until such batter is put out or reaches first base, unless the pitcher sustains injury or illness which, in the judgment of the umpire-in-chief, incapacitates him from pitching. [cite: 4774]
(g) Minimum Batters Faced Requirements
(1) The starting pitcher or any substitute pitcher is required to pitch to a minimum of three consecutive batters, including the batter then at bat (or any substitute batter), until such batters are put out or reach first base, or until the offensive team is put out, unless the starting pitcher or substitute pitcher sustains injury or illness which, in the umpire-in-chief's judgment, incapacitates him from further play as a pitcher. [cite: 4776]
(h) If an improper substitution is made for the pitcher, the umpire shall direct the proper pitcher to return to the game until the provisions of this rule are fulfilled. [cite: 4787]
(l) Visits to the Mound Requiring a Pitcher's Removal From the Game
(1) This rule limits the number of trips a manager or coach may make to any one pitcher in any one inning; [cite: 4816]
(2) A second trip to the same pitcher in the same inning will cause this pitcher's automatic removal from the game; [cite: 4817]
(m) Limitation on the Number of Mound Visits Per Game
(1) Mound visits without a pitching change shall be limited to four per team, per nine innings. [cite: 4835]
For any extra inning played, each team shall be entitled to one additional non-pitching-change mound visit in that inning, which if not used in that inning, will not carry over to any subsequent extra inning played. [cite: 4836, 4839]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.11', 'Designated Hitter Rule', $body$(a) The Designated Hitter Rule provides as follows: [cite: 4866]
(1) A hitter may be designated to bat for the starting pitcher and all subsequent pitchers in any game without otherwise affecting the status of the pitcher(s) in the game. [cite: 4867]
A Designated Hitter for the pitcher, if any, must be selected prior to the game and must be included in the lineup cards presented to the umpire-in-chief. [cite: 4868]
(2) The Designated Hitter named in the starting lineup must come to bat at least one time, unless the opposing Club changes pitchers. [cite: 4872]
(3) It is not mandatory that a Club designate a hitter for the pitcher, but failure to do so prior to the game precludes the use of a Designated Hitter for that Club for that game. [cite: 4873]
(4) Pinch-hitters for a Designated Hitter may be used. [cite: 4874]
Any substitute hitter for a Designated Hitter becomes the Designated Hitter. A replaced Designated Hitter shall not re-enter the game in any capacity. [cite: 4874, 4875]
(7) A Designated Hitter is "locked" into the batting order. [cite: 4882]
No multiple substitutions may be made that will alter the batting rotation of the Designated Hitter. [cite: 4883]
(8) Once the game pitcher is switched from the mound to a position on defense, such move shall terminate the Designated Hitter role for that Club for the remainder of the game. [cite: 4884]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '5.12', 'Calling "Time" and Dead Balls', $body$(a) When an umpire suspends play, he shall call "Time." [cite: 4912]
At the umpire-in-chief's call of "Play," the suspension is lifted and play resumes. [cite: 4913]
Between the call of "Time" and the call of "Play" the ball is dead. [cite: 4914]
(b) The ball becomes dead when an umpire calls "Time." The umpire-in-chief shall call "Time" when: [cite: 4915]
(1) When in his judgment weather, darkness or similar conditions make immediate further play impossible; [cite: 4916]
(2) When light failure makes it difficult or impossible for the umpires to follow the play; [cite: 4917]
(3) When an accident incapacitates a player or an umpire; [cite: 4919]
(4) When a manager requests "Time" for a substitution, or for a conference with one of his players. [cite: 4921]
(5) When the umpire wishes to examine the ball, to consult with either manager, or for any similar cause. [cite: 4922]
(6) When a fielder, after catching a fly ball, steps or falls into any out-of-play area. [cite: 4923]
(7) When an umpire orders a player or any other person removed from the playing field. [cite: 4925]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '6.01', 'Interference, Obstruction, and Catcher Collisions', $body$(a) Batter or Runner Interference. It is interference by a batter or a runner when: [cite: 4935, 4936]
(1) After a third strike that is not caught by the catcher, the batter-runner clearly hinders the catcher in his attempt to field the ball. [cite: 4937]
Such batter-runner is out, the ball is dead, and all other runners return to the bases they occupied at the time of the pitch. [cite: 4938]
(6) If, in the judgment of the umpire, a base runner willfully and deliberately interferes with a batted ball or a fielder in the act of fielding a batted ball with the obvious intent to break up a double play, the ball is dead. [cite: 4951]
The umpire shall call the runner out for interference and also call out the batter-runner because of the action of his teammate. [cite: 4952]
(10) He fails to avoid a fielder who is attempting to field a batted ball, or intentionally interferes with a thrown ball, provided that if two or more fielders attempt to field a batted ball, and the runner comes in contact with one or more of them, the umpire shall determine which fielder is entitled to the benefit of this rule, and shall not declare the runner out for coming in contact with a fielder other than the one the umpire determines to be entitled to field such a ball. [cite: 4959]
(h) Obstruction. When obstruction occurs, the umpire shall call or signal "Obstruction." [cite: 5049]
(1) If a play is being made on the obstructed runner, or if the batter-runner is obstructed before he touches first base, the ball is dead and all runners shall advance, without liability to be put out, to the bases they would have reached, in the umpire's judgment, if there had been no obstruction. [cite: 5050]
The obstructed runner shall be awarded at least one base beyond the base he had last legally touched before the obstruction. [cite: 5051]
(2) If no play is being made on the obstructed runner, the play shall proceed until no further action is possible. [cite: 5060]
The umpire shall then call "Time" and impose such penalties, if any, as in his judgment will nullify the act of obstruction. [cite: 5061]
(i) Collisions at Home Plate
(1) A runner attempting to score may not deviate from his direct pathway to the plate in order to initiate contact with the catcher, or otherwise initiate an avoidable collision. [cite: 5073]
(2) Unless the catcher is in possession of the ball, the catcher cannot block the pathway of the runner as he is attempting to score. [cite: 5081]
(j) Sliding to Bases on Double Play Attempts. If a runner does not engage in a bona fide slide, and initiates (or attempts to make) contact with the fielder for the purpose of breaking up a double play, he should be called for interference under this Rule 6.01. [cite: 5095]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '6.02', 'Pitcher Illegal Action', $body$(a) Balks. If there is a runner, or runners, it is a balk when: [cite: 5109, 5110]
(1) The pitcher, while touching his plate, makes any motion naturally associated with his pitch and fails to make such delivery; [cite: 5111]
(2) The pitcher, while touching his plate, feints a throw to first or third base and fails to complete the throw; [cite: 5115]
(3) The pitcher, while touching his plate, fails to step directly toward a base before throwing to that base; [cite: 5116]
(4) The pitcher, while touching his plate, throws, or feints a throw to an unoccupied base, except for the purpose of making a play; [cite: 5123]
(5) The pitcher makes an illegal pitch; [cite: 5125]
(6) The pitcher delivers the ball to the batter while he is not facing the batter; [cite: 5130]
(7) The pitcher makes any motion naturally associated with his pitch while he is not touching the pitcher's plate; [cite: 5133]
(8) The pitcher unnecessarily delays the game; [cite: 5134]
(9) The pitcher, without having the ball, stands on or astride the pitcher's plate or while off the plate, he feints a pitch; [cite: 5139]
(10) The pitcher, after coming to a legal pitching position, removes one hand from the ball other than in an actual pitch, or in throwing to a base; [cite: 5140]
(11) The pitcher, while touching his plate, accidentally or intentionally has the ball slip or fall out of his hand or glove; [cite: 5141, 5143]
(12) The pitcher, while giving an intentional base on balls, pitches when the catcher is not in the catcher's box; [cite: 5144]
(13) The pitcher delivers the pitch from Set Position without coming to a stop. [cite: 5145]
(b) Illegal Pitches With Bases Unoccupied. If the pitcher makes an illegal pitch with the bases unoccupied, it shall be called a ball unless the batter reaches first base on a hit, an error, a base on balls, a hit batter or otherwise. [cite: 5158]
(c) Pitching Prohibitions. The pitcher shall not: [cite: 5162]
(1) While in the 18-foot circle surrounding the pitcher's plate, touch the ball after touching his mouth or lips, or touch his mouth or lips while he is in contact with the pitcher's plate. [cite: 5163]
(2) expectorate on the ball, either hand or his glove; [cite: 5171]
(3) rub the ball on his glove, person or clothing; [cite: 5172]
(4) apply a foreign substance of any kind to the ball; [cite: 5173]
(5) deface the ball in any manner; or [cite: 5174]
(6) deliver a ball altered in a manner prescribed by Rule 6.02(c)(2) through (5) or what is called the "shine" ball, "spit" ball, "mud" ball or "emery" ball. [cite: 5175]
(7) Have on his person, or in his possession, any foreign substance. [cite: 5177]
(9) Intentionally Pitch at the Batter. [cite: 5182]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '6.03', 'Batter Illegal Action', $body$(a) A batter is out for illegal action when: [cite: 5214]
(1) He hits a ball with one or both feet on the ground entirely outside the batter's box. [cite: 5215]
(2) He steps from one batter's box to the other while the pitcher is in position ready to pitch; [cite: 5219]
(3) He interferes with the catcher's fielding or throwing by stepping out of the batter's box or making any other movement that hinders the catcher's play at home base. [cite: 5220]
(4) He throws his bat into fair or foul territory and hits a catcher (including the catcher's glove) and the catcher was attempting to catch a pitch with a runner(s) on base and/or the pitch was a third strike. [cite: 5221, 5224]
(5) He uses or attempts to use a bat that, in the umpire's judgment, has been altered or tampered with in such a way to improve the distance factor or cause an unusual reaction on the baseball. [cite: 5233]
(b) Batting Out of Turn
(1) A batter shall be called out, on appeal, when he fails to bat in his proper turn, and another batter completes a time at bat in his place. [cite: 5241]
(3) When an improper batter becomes a runner or is put out, and the defensive team appeals to the umpire before the first pitch to the next batter of either team, or before any play or attempted play, the umpire shall (1) declare the proper batter out; and (2) nullify any advance or score made because of a ball batted by the improper batter or because of the improper batter's advance to first base on a hit, an error, a base on balls, a hit batter or otherwise. [cite: 5243, 5244]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '6.04', 'Unsportsmanlike Conduct', $body$(a) No manager, player, substitute, coach, trainer or batboy shall at any time, whether from the bench, the coach's box or on the playing field, or elsewhere:
(1) Incite, or try to incite, by word or sign a demonstration by spectators;
(2) Use language which will in any manner refer to or reflect upon opposing players, an umpire, or any spectator; [cite: 5293]
(3) Call "Time," or employ any other word or phrase or commit any act while the ball is alive and in play for the obvious purpose of trying to make the pitcher commit a balk. [cite: 5294]
(4) Make intentional contact with the umpire in any manner. [cite: 5295]
(b) Players in uniform shall not address or mingle with spectator, nor sit in the stands before, during, or after a game. No manager, coach or player shall address any spectator before or during a game. Players of opposing teams shall not fraternize at any time while in uniform. [cite: 5296, 5297, 5298]
(d) When a manager, player, coach or trainer is ejected from a game, he shall leave the field immediately and take no further part in that game. He shall remain in the clubhouse or change to street clothes and either leave the park or take a seat in the grandstand well removed from the vicinity of his team's bench or bullpen. [cite: 5301, 5302]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '7.01', 'Regulation Games', $body$(a) A regulation game consists of nine innings, unless extended because of a tie score, or shortened (1) because the home team needs none of its half of the ninth inning or only a fraction of it, or (2) because the umpire-in-chief or the Office of the Commissioner calls the game. [cite: 5311]
(b) Extra Innings
(1) If the score is tied after nine completed innings, play shall continue until (1) the visiting team has scored more total runs than the home team at the end of a completed inning, or (2) the home team scores the winning run in an uncompleted inning. [cite: 5312]
(2) Each half-inning following the ninth inning will begin with a runner on second base. [cite: 5313]
(c) The umpire-in-chief or the Office of the Commissioner may postpone or call a game because of weather, field or ballpark conditions, malfunction of equipment, air quality, a curfew, loss of electricity or lighting, local or national emergencies or disasters, government restrictions, darkness, the health and safety of fans, players, team or stadium employees, or any extraordinary circumstances that prevent the game from being played or continued safely. [cite: 5324]
(d) A called game shall be considered a regulation game if five innings have been completed. [cite: 5325]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '7.02', 'Suspended Games', $body$(a) Any postponed game or game that is called: (1) prior to it becoming a regulation game, (2) when the game is tied, or (3) while an inning is in progress and before the inning is completed, and the visiting team has scored one or more runs to tie the game or take the lead and the home team has not retied the game or retaken the lead, must be immediately scheduled to be resumed and/or played to a completed regulation game. [cite: 5340]
(b) Postponed games or suspended games must be immediately scheduled to be resumed and/or played to a completed regulation game during a scheduled series between the Clubs, preferably on the same grounds, or on a mutual off-day. [cite: 5341]
(g) The Major Leagues have determined that Rule 7.01(b)(2) (runner on second base in Extra Innings) does not apply to any Wild Card Series, Division Series, League Championship Series or World Series games. [cite: 5349]
(h) A suspended game shall be resumed at the exact point of suspension of the original game. [cite: 5351]
The completion of a suspended game is a continuation of the original game. [cite: 5352]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '7.03', 'Forfeited Games', $body$(a) A game may be forfeited to the opposing team when a team:
(1) Fails to appear upon the field, or being upon the field, refuses to start play within five minutes after the umpire-in-chief has called "Play" at the appointed hour for beginning the game, unless such delayed appearance is, in the umpire-in-chief's judgment, unavoidable; [cite: 5361]
(2) Employs tactics palpably designed to delay or shorten the game; [cite: 5362]
(3) Refuses to continue play during a game unless the game has been suspended or terminated by the umpire-in-chief; [cite: 5363]
(4) Fails to resume play, after a suspension, within one minute after the umpire-in-chief has called "Play;" [cite: 5364]
(5) After warning by the umpire, willfully and persistently violates any rules of the game; [cite: 5365]
(6) Fails to obey within a reasonable time the umpire's order for removal of a player from the game; [cite: 5366]
(7) Fails to appear for the second game of a doubleheader within thirty minutes after the close of the first game. [cite: 5367]
(b) A game shall be forfeited to the opposing team when a team is unable or refuses to place nine players on the field. [cite: 5368]
(d) If the umpire-in-chief declares a game forfeited, he shall transmit a written report to the Office of the Commissioner within 24 hours thereafter, but failure of such transmittal shall not affect the forfeiture. [cite: 5370]$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mlb'), '7.04', 'Protesting Games', $body$Protesting a game shall never be permitted, regardless of whether such complaint is based on judgment decisions by the umpire or an allegation that an umpire misapplied these rules or otherwise rendered a decision in violation of these rules. [cite: 5371]$body$, 'baseball');


-- ------------------------------------------------------------
-- 5B. LITTLE LEAGUE INTERNATIONAL — 18 rows
--
-- NOTE: Rules 1.01–1.09, 1.11–1.17 contain combined
-- baseball/softball text in a single JSON object. They are
-- seeded with sport='baseball' (the column default). When you
-- are ready to split them into sport-specific rows, add new
-- rows with sport='softball' against the same rule_number.
--
-- Rule 1.10 appears TWICE in the source file: once for
-- baseball, once for softball. These are correctly mapped to
-- separate rows using the sport column — the primary design
-- goal of Option B.
-- ------------------------------------------------------------

INSERT INTO rules (league_id, rule_number, title, body, sport) VALUES

((SELECT id FROM leagues WHERE slug='little-league'), '1.01', 'Objectives of the Game', $body$Little League Baseball and Softball in all divisions is a game between two teams of nine players each, under the direction of a manager and not more than two (2) rostered coaches, played on a regulation Little League field in accordance with these rules, under jurisdiction of one or more umpires. Tee Ball/Minor League Instructional Division is a game between two teams, under the direction of a manager and not more than three rostered coaches, played on a regulation Little League field in accordance with these rules, under the jurisdiction of one or more umpires. NOTE: Competitive Minor Leagues and above may only use nine (9) players on defense. Local League Option: A game may not be started with less than eight (8) players on each team. See Rules 4.16 and 4.17.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.02', 'Objectives of the Game', $body$The objective of each team is to win by scoring more runs than the opponent. (Tee Ball: It is recommended that no score be kept.)$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.03', 'Objectives of the Game', $body$The winner of the game shall be that team which shall have scored, in accordance with these rules, the greater number of runs at the conclusion of a regulation game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.04', 'The Playing Field', $body$The field shall be laid out according to the instructions, supplemented by Diagram No. 1 and No. 2. (BASEBALL/SOFTBALL) The infield shall be a 60-foot square. Diagrams No. 3, No. 4 and No. 5 for Intermediate (50-70) Division/Junior/Senior League. (BASEBALL) (TEE BALL OPTION: The infield may be a 50-foot square.) [Intermediate (50-70) division baseball: 90-foot square.] [Junior/senior league BASEBALL: 90-foot square.] [CHALLENGER: The infield shall be a 50- or 60-foot square.] The outfield shall be the area between two foul lines formed by extending two sides of the square, as in Diagram 1. The distance from home base to the nearest fence, stand, or other obstruction on fair territory should be 200 feet or more. BASEBALL: [200 feet or more for Intermediate (50-70) Division and 300 feet or more for Junior/Senior League]. A distance of 200 feet or more along the foul lines and to center field is recommended. The infield shall be graded so that the base lines and home plate are level. SOFTBALL: A distance of 200 feet or more along the foul lines, and to centerfield is recommended. The outfield fence must be a minimum of 180 feet and a maximum of 225 feet from home plate. PITCHER'S PLATE: BASEBALL: The pitcher's plate shall be six inches [eight inches for Intermediate (50-70) Division and 10 inches for Junior/Senior League] above the level of home plate. SOFTBALL: Little League/Junior/Senior League: The pitcher's plate shall be level with the ground. The infield and outfield, including the boundary lines, are fair territory and all other area is foul territory. It is recommended that the distance from home base to the backstop, and from the baselines to the nearest fence, stand or other obstruction on foul territory should be 25 feet or more [45 feet for Intermediate, Junior and Senior Divisions].$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.05', 'Home Base', $body$Home base shall be marked by a five-sided slab of whitened rubber. It shall be a 17-inch square with two of the corners filled in so that one edge is 17 inches long, two 8 1/2 inches and two are 12 inches. It shall be set in the ground with the point at the intersection of the lines extending from home base to first base and to third base; with the 17-inch edge facing the pitcher's plate and the two 12-inch edges coinciding with the first and third base lines. The top edges of home base shall be beveled and the base shall be fixed in the ground level with the ground surface. The black beveled edge is not considered part of home plate.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.06', 'First, Second, and Third Bases', $body$First, second, and third bases shall be marked by white canvas or rubber covered bags, securely attached to the ground. The first and third base bags shall be entirely within the infield. The second base bag shall be centered on second base. The base bags shall not be less than fourteen (14) nor more than fifteen (15) inches square and the outer edges shall not be more than two and one-fourth (2 1/4) inches thick and filled with a soft material. Leagues are required to ensure that first, second, and third bases will disengage their anchor. NOTE 1: If a base is dislodged from its position during a play, any following runner on the same play shall be considered as touching or occupying the base if, in the umpire's judgment, that runner touches or occupies the dislodged bag or the point marked by the original location of the dislodged bag. NOTE 2: Use of the "Double First Base" is permissible at all levels of play. See Rule 7.15.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.07', 'Pitcher''s Plate', $body$The pitcher's plate shall be a rectangular slab of whitened rubber... BASEBALL: 18 inches by 4 inches [24 inches by 6 inches for Intermediate (50-70) Division/Junior/Senior League]. It shall be set in the ground as shown in the Diagrams 6 and 7, so that the distance between the front side of the pitcher's plate and home base (the rear point of home plate) shall be 46 feet [50 feet for Intermediate (50-70) Division and 60 feet, 6 inches for Junior/Senior League); SOFTBALL: 24 inches by 6 inches. It shall be set in the ground as shown in Diagrams 1 and 2, so that the distance between the front side of the pitcher's plate and homebase (the rear point of home plate) shall be: (1) Minor League: 35 feet; (2) Little League (Majors): 40 feet; and (3) Junior/Senior League: 43 feet.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.08', 'Players'' Benches', $body$The league shall furnish players' benches, one each for the home and visiting teams. Such benches should be not less than 25 feet from the base lines. They shall be protected by wire fencing. NOTE 1: The on-deck position is not permitted in Tee Ball, Minor League, or Little League (Major) Division. A.R.-Fenced-in areas MAY NOT be used for an on-deck batter. NOTE 2: Only the first batter of each half-inning will be permitted outside the dugout between half-innings in Tee Ball, Minor League, or Little League (Major) Division. A.R. The next batter should be ready with a helmet on but may not pick up a bat until it is his/her turn at bat.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.09', 'The Ball', $body$BASEBALL: The ball used must meet Little League specifications and standards. It shall weigh not less than five (5) nor more than five and one-fourth (5 1/4) ounces, and measure not less than nine (9) nor more than nine and one-fourth (9 1/4) inches in circumference. (Tee Ball: The ball may carry the words "Little League Tee Ball.") NOTE: Baseballs licensed by Little League will be printed with one of two designations: "RS" (for regular season play) or "RS-T" (for regular season and tournament play). SOFTBALL: The softball used must meet Little League specifications and standards. The ball shall be not less than 11-7/8" nor more than 12-1/8" in circumference and shall weigh not less than 6 1/4 ounces nor more than 7 ounces. Tee Ball/Minor League: The ball shall be not less than 10-7/8" nor more than 11-1/8" in circumference and shall weigh not less than 5-1/2 ounces nor more than 6 ounces.$body$, 'baseball'),

-- Rule 1.10 BASEBALL version
((SELECT id FROM leagues WHERE slug='little-league'), '1.10', 'The Bat', $body$BASEBALL: The bat must be a baseball bat which meets USA Baseball Bat standard (USABat) as adopted by Little League. It shall be a smooth, rounded stick, and made of wood or of material and color tested and proved acceptable to the USA Baseball Bat standard (USABat). Non-wood and laminated bats used in the Little League (Majors) and below, Intermediate (50-70) Division, and Junior League divisions shall bear the USA Baseball logo signifying that the bat meets the USABat USA Baseball's Youth Bat Performance Standard. All BPF - 1.15 bats are prohibited. The bat diameter shall not exceed 2 5/8 inches for these divisions of play. Bats meeting the Batted Ball Coefficient of Restitution (BBCOR) standard may also be used in the Intermediate (50-70) Division and Junior League Division. Additional information is available at LittleLeague.org/Batinfo. Minor/Major Divisions: It shall not be more than 33 inches in length; nor more than 2 5/8 inches in diameter, and if wood, not less than fifteen-sixteenths (15/16) inches in diameter (7/8 inch for bats less than 30") at its smallest part. Wood bats taped or fitted with a sleeve may not exceed sixteen (16) inches from the small end. NOTE 1: The traditional batting donut is not permissible. NOTE 2: The use of pine tar or any other similar adhesive substance is prohibited at all levels of Little League Baseball. NOTE 3: Non-wood bats may develop dents from time to time. Bats that have cracks or sharp edges, or that cannot pass through the approved Little League bat ring for the appropriate division must be removed from play. NOTE 4: An illegal bat must be removed. Any bat that has been altered shall be removed from play. PENALTY - See Rule 6.06(d). A.R. - If the certification mark/s on a bat are not legible, that bat cannot be used and shall be removed from the game.$body$, 'baseball'),

-- Rule 1.10 SOFTBALL version — same rule_number, different sport: no UNIQUE conflict
((SELECT id FROM leagues WHERE slug='little-league'), '1.10', 'The Bat (Softball)', $body$SOFTBALL: The bat must be a softball bat which meets Little League specifications and standards as noted in this rule. It shall be a smooth, rounded stick and made of wood or a material tested and proved acceptable to Little League standards. The bat shall be no more than 33 inches (34 inches for Junior/Senior League) in length, not more than two and one-quarter (2 1/4) inches in diameter, and if wood, not less than fifteen-sixteenth (15/16) inches in diameter (7/8 inch for bats less than 30 inches) at its smallest part. Non-wood bats shall be printed with a BPF (bat performance factor) of 1.20. Bats may be taped or fitted with a sleeve for a distance not exceeding 16 inches from the small end. Colored bats are acceptable. A non-wood bat must have a grip of cork, tape, or composition material, and must extend a minimum of 10 inches from the small end. Slippery tape or similar material is prohibited. An illegal or altered bat must be removed. PENALTY - See Rule 6.06(d). A.R. If the specification mark(s) on a bat are not legible, that bat cannot be used and shall be removed from the game. NOTE 1: The traditional batting donut is not permissible. NOTE 2: The use of pine tar or any other similar adhesive substance is prohibited at all levels of Little League Softball. NOTE 3: Non-wood bats may develop dents from time to time. Bats that have cracks or sharp edges or cannot pass through the approved Little League bat ring must be removed from play. The 2 1/4 inch bat ring must be used for bats in all softball divisions. Any bat that has been altered shall be removed from play.$body$, 'softball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.11', 'Uniforms', $body$(a) (1) All players on a team shall wear numbered uniforms identical in color, trim, and style. (ALL DIVISIONS OF SOFTBALL): The wearing of hats or visors is optional for each player while on defense. (2) The Little League Official Shoulder Patch must be affixed to the upper left sleeve or left chest of the uniform shirt. (3) Any part of the pitcher's undershirt or T-shirt exposed to view shall be of a solid color. For baseball the sleeves may not be white or gray. The use of play calling bands by defensive players is permitted under the following conditions: The equipment must be worn as the manufacturer intended (i.e. on either the wrist or forearm). Baseball and Softball pitchers are permitted to wear a play calling band on their non-pitching (glove) arm, provided it is a solid color and not white, gray, or optic yellow. If the umpire considers it distracting to the batter, he/she may have it removed. (b) A league must provide each team with a distinctive uniform. (j) Players must not wear jewelry such as, but not limited to, rings, watches, earrings, bracelets, necklaces, nor any hard cosmetic/decorative items. EXCEPTION: Jewelry that alerts medical personnel to a specific condition is permissible. (k) Casts may not be worn during the game by players and umpires. NOTE: Persons wearing casts, including managers and coaches, must remain in the dugout during the game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.12', 'Catcher''s Mitt', $body$BASEBALL: The catcher must wear a catcher's mitt (not a first baseman's mitt or fielder's glove) of any shape, size, or weight consistent with protecting the hand. SOFTBALL: The catcher must wear a mitt of any shape, size, or weight consistent with protecting the hand. This may be a first baseman's mitt or a fielder's glove.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.13', 'First Baseman''s Glove', $body$The first baseman must wear a glove or mitt of any weight with the following maximum specifications: (a) not more than 14 inches long (measured from the bottom edge or heel straight up across the center of the palm to a line even with the highest point of the glove or mitt), and; (b) not more than eight inches wide across the palm (measured from the bottom edge of the webbing farthest from the thumb in a horizontal line to the outside of the little finger edge of the glove or mitt) and; (c) webbing not more than 5 3/4 inches wide (measured across the top end or along any line parallel to the top).$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.14', 'Fielder''s Glove', $body$Each defensive player (other than the first baseman and catcher) must wear a glove of any weight, with the same maximum specifications as noted in Rule 1.13.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.15', 'Pitcher''s Glove', $body$(a) BASEBALL: The pitcher's glove may not, exclusive of piping, be white or light gray nor, in the judgment of an umpire, distracting in any manner. SOFTBALL: The pitcher's glove shall be of one solid color or multi-colored as long as the color(s) are not the color of the ball, optic yellow, being used in the game. A glove that is judged to be distracting is illegal. (b) BASEBALL: No pitcher shall attach to the glove any foreign material of a color different than the glove. SOFTBALL: No pitcher shall attach to the glove any foreign material of a color different from the glove. (c) SOFTBALL: Pitchers shall not wear any item on the pitching hand, wrist, or arm. A pitcher may wear items on the glove hand, wrist, or arm (non-pitching arm) of a solid single color: black, white, gray, or a uniform color. A pitcher shall not wear any items on their hands, wrists, or arms which the umpire may judge to be distracting. EXCEPTION: A pitcher may wear a compression sleeve on the pitching arm of a solid, single color: black, white, gray, or a uniform color. (d) SOFTBALL: A pitcher may not wear a catcher's mitt or first baseman's mitt.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.16', 'Helmets', $body$Each league shall provide in the dugout or bench of the offensive team six (6), seven (7) for Intermediate (50-70) Division/Junior/Senior League] protective helmets which must meet NOCSAE specifications and standards. Use of the helmet by the batter, all base runners and youth base coaches is mandatory. Use of a helmet by an adult base coach or any defensive player is optional. Each helmet shall have an exterior warning label. Helmets must have a non-glare surface and cannot be mirror-like in nature. Warning! Manufacturers have advised that altering helmets in any way can be dangerous. Altering the helmet in any form, including painting or adding decals (by anyone other than the manufacturer or authorized dealer) may void the helmet warranty. Helmets may not be re-painted and may not contain tape or re-applied decals unless approved in writing by the helmet manufacturer or authorized dealer. A.R. If a player, during play, removes their helmet or causes their helmet to come off, they shall NOT be called out, but shall be warned not to intentionally remove his/her helmet and, if it continues, the player may be removed for unsportsmanlike conduct.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='little-league'), '1.17', 'Catcher''s Equipment', $body$All male players must wear athletic supporters. Male catchers must wear the metal, fiber or plastic type cup, and a long or short model chest protector. Female catchers must wear long or short model chest protectors. All catchers must wear chest protectors with neck collar, throat guard, shin guards and a catcher's helmet, all of which must meet Little League specifications and standards, and bear the NOCSAE stamp. All catchers must wear a mask, "dangling" type throat protector and catcher's helmet during infield/outfield practice, pitcher warm-up and games. NOTE: Skullcaps are not permitted. Warning! Manufacturers have advised that altering helmets in any way can be dangerous. A.R.-Wearing of a catcher's helmet with mask and dangling throat guard (even if the mask has a wire extension) is required during games, pitcher warm-up, and any form of infield or infield/outfield practice. The "Hockey Style" helmet is authorized for use at all levels of play. The "dangling" throat guard still must be attached properly.$body$, 'baseball');


-- ------------------------------------------------------------
-- 5C. USSSA — 5 rules, all sport = 'baseball'
-- (league, isPrimary, overrides fields from JSON are dropped;
--  they are now represented by leagues.parent_league_id)
-- ------------------------------------------------------------

INSERT INTO rules (league_id, rule_number, title, body, sport) VALUES

((SELECT id FROM leagues WHERE slug='usssa'), 'USSSA-001', 'USSSA Baseball Rules', $body$OFFICIAL BASEBALL NATIONAL BY-LAWS & RULES Edition Dated: August 1, 2024. Playing rules not specifically covered herein shall be governed by The Official MLB Rules of Baseball National League. If any conflict in rules between these Official USSSA Baseball National By-Laws & Rules and The Official MLB Rules of Baseball National League, these Official USSSA Baseball National By-Laws & Rules shall govern.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='usssa'), 'USSSA-002', 'RULE 7.03 - STARTING AND ENDING A GAME', $body$7.03.A A regulation game consists of six (6) innings for age divisions 4U-12U and seven (7) innings for age divisions 13U and older, unless the game is:
7.03.A.1 Extended because the score is tied after the completion of the regulation number of innings, in which case, play shall continue until the visiting team has scored more total runs than the home team at the end of a completed inning, or the home team scores the winning run in an uncompleted inning.
7.03.A.2 Shortened because the home team needs none of its half of the last inning or only a fraction of it to win.
7.03.A.3 Shortened because an imposed Time Limit expires; or
7.03.A.4 Shortened because any applicable part of USSSA Rule 7.03.B has been met.
7.03.A.5 Shortened because any applicable part of USSSA Rule 7.03.C has been met.
7.03.A.6 Pool play games can end in a tie if the time limit is up or a complete game has been played.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='usssa'), 'USSSA-003', 'RULE 7.05 - THE PITCHER', $body$7.05.B PITCHING LIMITATIONS: The end of the day for the purpose of this rule shall be the time of day or night when the ball park is shut down and the teams go home for the night break. Games that for any reason extend past midnight (12:00 AM) or start late at night, past midnight (12:00 AM) and are completed before the teams take the night break, shall count as being played on the scheduled day. A game not completed before the night break shall be a suspended game.
7.05.B.1 ONE DAY MAXIMUM TO PITCH THE NEXT DAY: The maximum number of innings a player can legally pitch in one (1) day and still pitch the next day. Rule 7.05.B.1 Example: In the 7U-14U age divisions, a player may legally pitch a maximum of three (3) innings in one (1) day and still legally pitch the next day. If the player pitches three and one-third (3 1/3) or more innings in one (1) day, the player cannot legally pitch the next day.
7.05.B.2 ONE DAY MAXIMUM: The maximum number of innings a player can legally pitch in one (1) day. Rule 7.05.B.2 Example: In the 7U-12U age divisions, a player may legally pitch a maximum of six (6) innings in one (1) day. The player would be ineligible to pitch the next day.
7.05.B.3 THREE DAY MAXIMUM: The maximum number of innings a player can legally pitch in three (3) consecutive days.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='usssa'), 'USSSA-004', 'RULE 8.00 - COACH PITCH SPECIFIC RULES', $body$8.01 Fair Ball Arc: There shall be a twenty (20) foot arc drawn from first (1st) base line to third (3rd) base line in front of home plate. A batted ball must go past this line to be a fair ball.
8.02 Safety Arc: There shall be a thirty (30) foot arc drawn from first (1st) base line to third (3rd) base line in front of home plate. Infielders must stay behind this line until the ball is hit.
8.03 Pitching Circle: There shall be a ten (10) foot diameter circle with the front edge at forty-two (42) feet from the rear point of home plate.
8.04 Pitching Coach: The Pitching Coach shall be an adult at least eighteen (18) years of age.
8.05 Ten (10) defensive players shall play in the field with four (4) outfielders. The fourth (4th) outfielder shall not assume an infield position. All outfielders shall stay behind the base line.
8.06 The defensive player listed as pitcher shall not leave the pitching circle until the ball is hit.
8.07 Defensive coaches shall not be allowed on the field of play and shall coach from the dugout.
8.08 The Infield Fly Rule shall not be in effect at any time.
8.09 The batting order shall constitute all present players on the team roster at the beginning of the game. Late arrivals shall be inserted at the bottom of the batting order.
8.10 Teams may start a game with eight (8) players. The ninth (9th) & tenth (10th) positions in the batting order shall be declared an out each turn at bat.
8.11 Teams may use free substitution on defense, but the batting order shall remain the same.
8.12 Bunting shall not be allowed.
8.13 The batter shall receive a maximum of six (6) pitches or three (3) swinging strikes.
8.14 A player may only be Intentionally Walked once per game by announcement from the defensive team.
8.15 Runners shall not lead-off or steal bases. A runner is out for leaving the base before the ball is hit or reaches home plate.
8.16 A courtesy runner for catcher of record only the previous inning may be used.
8.17 A team may score a maximum of seven (7) runs per inning.
8.18 The game is over, when the opposing team is mathematically eliminated from scoring enough runs to win or tie the game.
8.19 Umpire judgment shall be used to determine if all the runners are not attempting to advance.
8.20 When a batted ball hits the Pitching Coach, the following shall apply:
8.21.A If in the Umpire's judgment the ball would have been a fair ball, the ball is dead and all runners shall advance.
8.21.B If in the Umpire's judgment the ball would have been a foul ball, the ball is dead and a foul ball is declared.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='usssa'), 'USSSA-005', 'RULE 9.00 - MACHINE PITCH SPECIFIC RULES', $body$9.01 Fair Ball Arc: There shall be a twenty (20) foot arc drawn from first (1st) base line to third (3rd) base line in front of home plate. A batted ball must go past this line to be a fair ball (this includes a ball that is legally bunted).
9.02 Safety Arc: There shall be a thirty (30) foot arc drawn from first (1st) base line to third (3rd) base line in front of home plate. Infielders must stay behind this line until the ball is hit.
9.03 Pitching Circle: There shall be a ten (10) foot diameter circle with the front edge at forty-two (42) feet from the rear point of home plate.
9.04 Pitching Machine: The front leg(s) shall be set at a distance of forty-two (42) feet from the rear point of home plate.
9.05 Recommended pitching machine speeds: 9.05.A 36 M.P.H. +/- 39 M.P.H. out of the machine for the 7U age division. 9.05.B 39 M.P.H. +/- 42 M.P.H. out of the machine for the 8U age division.
9.06 Pitching Machine Operator: The Pitching Machine operator shall be an adult at least eighteen (18) years of age.
9.07 Ten (10) defensive players shall play in the field with four (4) outfielders.
9.08 The defensive player listed as pitcher shall not leave the pitching circle until the ball is hit.
9.09 Defensive coaches shall not be allowed on the field of play and shall coach from the dugout.
9.10 The Infield Fly Rule shall not be in effect at any time.
9.11 The batting order shall constitute all present players on the team roster at the beginning of the game.
9.12 Teams may use free substitution on defense, but the batting order shall remain the same.
9.13 Teams may bunt a maximum of two (2) times per inning.
9.14 The batter shall receive a maximum of six (6) pitches or three (3) swinging strikes.
9.15 A player may only be Intentionally Walked once per game by announcement from the defensive team.
9.16 Runners shall not lead-off or steal bases. A runner is out for leaving the base before the ball is hit or reaches home plate.
9.17 A courtesy runner for catcher of record only the previous inning may be used.
9.18 A team may score a maximum of seven (7) runs per inning.
9.19 The game is over, when the opposing team is mathematically eliminated from scoring enough runs to win or tie the game.
9.20 Umpire judgment shall be used to determine if all the runners are not attempting to advance.
9.21 When a batted ball hits the pitching machine, the ball is dead, the batter is awarded first (1st) base and all runners shall advance one (1) base.$body$, 'baseball');


-- ------------------------------------------------------------
-- 5D. MILL VALLEY AAA — 37 rules, all sport = 'baseball'
-- (fallback_to field from JSON dropped; represented by
--  leagues.parent_league_id = little-league)
-- ------------------------------------------------------------

INSERT INTO rules (league_id, rule_number, title, body, sport) VALUES

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '1', 'Governing Rules', $body$All National Little League rules are in effect per 2024 "Official Regulations and Playing Rules" which can be downloaded from Little League International (www.littleleague.org), or viewed on the Little League Rulebook app, except as noted below.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '2', 'Game times', $body$During weekday games (Monday-Friday) where there is only one scheduled game or the final games on Saturdays, teams should strive to complete a full game. There is no 2 hour limit, but games must end by 8PM. No new inning should start after 7:45pm. Umpires may decide to end a game earlier if it is determined to be unsafe due to darkness or weather conditions. During Saturday or weekday games when there is a game to follow, games must end no later than 2 hours after the scheduled start time to allow for transitions of teams, field prep and warmups. No new inning should start after 1:45 after the scheduled start time. In all circumstances, refer to Rules 4.11 and 4.12 for games halted during an inning. Essentially, the final score will be the score at the end of the last completed full inning (a complete game is 4 innings). Games that are over 1 hour 45 minutes are complete games irrespective of the innings played.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '3', 'Rain', $body$When a field has not been closed by the City per the City's website (https://www.millvalleylibrary.org/477/Fields), teams are expected to show up at the field 45 minutes before the scheduled start. Our fields drain very well and showers in the morning may not result in cancellation. If a team does not appear and the field is playable, that team will be subject to a forfeit at the discretion of the MVLL Board. The AAA Commissioner or his/her designee will make the final decision regarding whether a field is playable.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '4', 'Dugouts', $body$Home teams as designated by the schedule shall occupy the 1st base dugout, visitors the 3rd base dugout.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '5', 'Batting Practice on Game Day Field', $body$Batting practice, soft toss, pepper, or any other drills involving swinging bats are prohibited on any game day field prior to scheduled start time. No On-Deck or practice swings are allowed ever. According to Little League International rules Appendix B - Safety Code for Little League: "Regulations prohibit on-deck batters. This means no player should handle a bat, even while in an enclosure, until it is their time at bat. This applies to Little League Majors, Minors [AAA], and Tee-Ball."$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '6', 'Continuous Batting Order', $body$Players attending the game shall bat in a continuous order throughout the entire game regardless of when they play in the field. (Note: 7.14(a) Special Pinch Runner and 7.14(b) Courtesy Runner do not apply).$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '7', '5-run Rule (Inning Mercy)', $body$The inning ends once a team has scored 5 runs. The 5-run rule does not apply in the final inning of a game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '8', '10-run Rule (Game Mercy)', $body$If after 4 innings (3.5 innings if home team ahead) one team has a lead of 10 or more runs, the losing team shall concede the victory to the opponent. If the teams wish to continue as a scrimmage, without interfering with a following game, they may do so, but the umpires will be excused at the completion of the regulation game. The 10-run rule does not apply in the final inning of a game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '9', 'Playing Time Local Rule', $body$Every player on the team roster will participate in each game for a minimum of half the scheduled innings in the field or three (3) complete innings. A complete inning is three (3) consecutive outs. A player who does not start in a game must start in the following game. Players can be alternated in consecutive innings.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '10', 'Adult Coaches', $body$Teams may have no more than 3 approved/certified adults within the confines of the field during a game. Adults may coach in the coach's boxes at 1st and 3rd bases when the team is on offense. When the team is not on offense all adults must be in the dugout. A team may have a scorekeeper sitting in the stands, but coaching should not be done from the stands or other field areas. One adult must be in the dugout at all times. Only adults within the confines of the field at the time of first pitch will be permitted. All adults on the field must have registered as a Volunteer through MVLL Registration, and must have successfully completed a background check as required by Little League International and the State of California.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '11', 'Offensive Time Outs', $body$Local: in the interest of time, only one offensive time out will be granted per inning.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '12', 'Defensive Time Outs', $body$Only one defensive time out will be granted per inning.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '13', 'Mound Visits', $body$In AAA, the manager or coach may visit a pitcher twice per inning; if there is a third visit in the inning to the same pitcher, the pitcher must be removed. Furthermore, the manager or coach can only visit a pitcher two times per game; if there is a third visit in the game to the same pitcher, the pitcher must be removed. See Rule 8.06.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '14', 'Runner Must Avoid Fielder/Sliding', $body$A runner must slide or attempt to go around a fielder who has the ball and is waiting to make a tag. Headfirst slides are illegal unless returning back to the base. Defensive players without the ball cannot block the base path. See Rules 7.08 and 7.09.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '15', 'Leadoffs', $body$There are no leadoffs in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '16', 'Stealing', $body$There is no stealing until each team has played four games. If, in a game, one team has played four games but the other has not, no stealing is allowed during that game. After all teams have played four games, the no-stealing rule is suspended. Runners are allowed to steal every base EXCEPT HOME. The ball must be put into play by a batter for a runner to advance to home. A runner must stop at third if there is an overthrow on a steal attempt. This rule is to develop the defensive skills of pitchers, catchers, and infielders. No leads are allowed at any time. Runners may only leave the base when the ball crosses home plate.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '17', 'Dropped 3rd Strike', $body$The "Dropped third strike" rule does not apply in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '18', 'Infield Fly Rule', $body$There is no Infield Fly Rule in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '19', 'Slash Bunts', $body$Slash bunts (where a batter fakes a bunt and then swings away) are not allowed in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '20', 'Pitching', $body$When a pitcher is in contact with the pitcher's plate and in possession of the ball AND the catcher is in the catcher's box ready to assume the receiving position, base runners shall not leave their bases until the ball has been delivered and has reached the batter. Runners who are more than halfway to the next base at that time may continue to that base, but not advance farther. If the catcher overthrows the pitcher, the runners may advance at their own risk. Delayed steals (when the base runner takes off when the catcher throws back to the pitcher but before the pitcher has the ball) are allowed in AAA after the stealing prohibition has been lifted early in the season.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '21', 'Pitching Local', $body$During the regular season, a pitcher may pitch a maximum of 2 innings or 6 consecutive outs. The 6 outs may span 3 innings. A pitcher may take another field position immediately under both National and local rules. A pitcher may not return to pitch having been removed from that position earlier in the game. A player may not pitch in more than one game in a day. During the postseason, a pitcher may pitch a maximum of 3 innings or 9 consecutive outs (the 9 outs may span 4 innings). Under all circumstances, teams must follow National rules regarding pitch count (refer to Regular Season Pitching Rules – Baseball).$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '22', 'Pitcher/Catcher', $body$A pitcher who throws 40 or more pitches in a game may not play in the catcher position. If the pitcher reaches 39 pitches while facing a batter, they may continue to pitch until that at-bat is completed, and then thereafter play the position of catcher for the remainder of that game. A catcher who catches less than 4 innings in a game may pitch. For the purposes of this rule, the catcher shall be considered to have caught 4 innings as soon as they receive the first pitch of the 4th inning, and then becomes ineligible to pitch in that game. A player who played the position of catcher for three (3) innings or less, moves to the pitcher position, and delivers 21 pitches or more (15- and 16-year-olds: 31 pitches or more) in the same day, may not return to the catcher position on that calendar day.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '23', 'Walks', $body$At the beginning of the season, there are no walks. On ball 4, a batting tee will be brought out and the strike count continues. A ball put in play off the tee can result in a foul ball, an out, or a single. The batter-runner may not advance past first base on that play. If the batter contacts only the tee, "foul ball" shall be ruled. The tee will be used at the beginning of the season until each team has played four games. If, in a game, one team has played four games but the other has not, the tee rule is to be used during that game. After all teams have played four games using the tee rule, the rule is suspended and normal Ball/Strike count rules apply.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '24', 'Intentional Walks', $body$Intentional walks are not allowed in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '25', 'Balks', $body$In AAA, a balk called by the umpire will result in a warning and be ruled "no pitch", as with any other illegal pitch. See Rule 8.05. Runners do not advance on balks in AAA.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '26', 'Pitch Count Rules', $body$A pitch is defined as a "ball delivered to the batter by the pitcher". Warm up pitches at the start of an inning do not count towards pitch count. Managers are responsible for keeping an accurate count of pitches thrown by each pitcher. Managers will designate a pitch counter for his or her team who will use a paper Baseball Game Pitch Log to keep track of pitches thrown. Managers should reconcile pitch counts on the half inning. Managers are required to confer at the end of the game, before the umpires leave the field, and review and agree on the pitch counts recorded for each pitcher on each team. The Baseball Pitcher Eligibility Tracking Form must be filled out by each team and dated and signed by both Managers. The agreed pitch counts cannot be overturned once the managers have left the field. Pitcher eligibility will consider pitches thrown competitively in both Little League and non-Little League games. Managers should make a reasonable effort to determine non-Little League pitch counts. For regular season games, if the managers cannot agree on the final pitch counts, the AAA Commissioner should be notified immediately. For post-season games in AAA, the managers should contact the AAA Commissioner to immediately resolve the issue. Game play will not resume until the pitch count discrepancy is resolved.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '27', 'Bats and Helmets', $body$Bats used in practices or games cannot be more than 33" in length; nor more than 2-5/8" in diameter. A bat must meet the USA Baseball Bat standards (see https://www.littleleague.org/help-center/usa-baseball-bat-standard-faqs/) for more information. Helmets must be affixed with the NOCSAE symbol, be free of cracks or other visible damage, and all of the internal padding must not be missing, tattered, torn or frayed. Managers are responsible for confirming that equipment conforms to this standard.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '28', 'Vocal Harassment', $body$Organized chatter, taunting or uniform cadenced speech intended to unnerve opposing players is not allowed by players or fans in the stands. Managers are responsible for maintaining the decorum of their players, coaches and parents/fans. Positive cheering is always encouraged. Repeated vocal harassment (i.e., continuing after a warning to stop) can result in ejection from the game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '29', 'Umpires', $body$Harassment of umpires by managers, coaches, players or parents/fans will not be tolerated. Managers, coaches, players and parents/fans will not shout "safe" or "out" or give the "safe" or "out" sign from the coach's boxes or shout "good pitch" in advance of umpire making a call. Such behavior shall be subject to warnings and/or ejection from the game. Any umpire's decision which involves judgment, such as, but not limited to, whether a batted ball is fair or foul, whether a pitch is a ball or strike, or whether a runner is safe or out, is final. No player, manager, coach or parent/fan shall object to any judgment decision. Coaches may not leave the dugout to approach an umpire unless the umpire grants time out first. Umpire calls may not be "appealed".$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '30', 'Clean Up/Post-Game Field Maintenance', $body$Each team is responsible for cleaning up litter in the dugout and stands before vacating the field. Managers should have a team parent encourage families to assist clean-up of the stands area before leaving. The home team drags and waters the field at the end of the game and covers the mound and home plate with the provided tarps.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '31', 'Outfield Fence Line - Friends Field', $body$A) The outfield fence line is to be set at the Little League recommended 180 feet from the back corner of home plate prior to the start of the game. Cones or markers will be set by the umpires signifying the fence line. Once the first pitch has been thrown, the fence line will remain unchanged throughout the game even if it has been set shorter or longer than the recommended 180 feet. B) When a batted fair ball lands over the outfield home run line on a fly it is deemed to be a home run. C) A fair ball touched or caught on the fly by a fielder standing beyond the home run line is a home run. D) A batted fair ball that travels over the fence line, whether touched by a fielder or not, is a ground rule double. E) When a ball travels over the home run line the outfielder nearest the ball should raise both hands over their head to signal to the umpire that it went over the line. Umpires are solely responsible for making these calls. The home team shall retrieve and store the fence line markers after the game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '32', 'Number of Players', $body$A team must have 9 players to start a game. If a team does not have 9 players, the team may be subject to a forfeit, with the decision resting with the MVLL Board per LL International Rules. If a team starts with 9 players but drops to 8 or less during the game, the game must stop. The team with less than 9 players may be subject to a forfeit, with the decision resting with the MVLL Board per LL International Rules. It is the manager's responsibility to determine how many players will be available for his or her game, and to request a pool player if the team will only have 9 players or less. Managers should encourage all players to participate (except in the case of illness, injury, or mandatory school event). "Differentials" (the difference between the number of players on each team) will be ignored.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '33', 'Playoffs', $body$Seeding: Unless the Commissioner decides otherwise, the seedings for playoffs will be determined by a) Win/Loss Percentage, b) head-to-head records and c) average runs against per game. The final tie-breaker will be a coin toss if needed. Number of Players: Pool players can only be used to avoid having less than 9 players at the beginning of the game. "Differentials" (the difference between the number of players on each team) will be ignored; automatic outs will not be imposed. Extra Innings: If a playoff game is tied after 6 innings, the 7th inning will be played using the same rules as the 6th. If additional innings are required to break a tie (i.e. 8th inning or more), each team will begin their respective at-bat by placing the player who made the last batted out in the previous inning at 2nd base.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '34', 'Conflicts/Protests', $body$National rules allow for a game to be played under protest. MVLL discourages formal protests as they often result in a game having to be re-played from the point of the alleged infraction, and with schedules so tight, this is not easy. MVLL encourages trying to solve the problem at game time. Using a cell phone both Managers and the Head Umpire should initiate a phone call to the Commissioner. Protests are governed by Rule 4.19; the procedure is outlined at Protest Rules. Protests that cannot be resolved by the umpires at the game and the Commissioner will be resolved by the MVLL Protest Committee.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '35', 'Use of Livestream', $body$MVLL provides livestreaming of games played at Boyle and Alto. Post-game replays from Livestream may only be used by the Protest Committee to adjudicate Rule 4.19 protests (specifically, violations or interpretations of a playing rule, the use of an ineligible pitcher, or the use of an ineligible player).$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), '36', 'Questions', $body$Any questions should be directed to the AAA League Commissioner, Jeff O'Brien.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='mill-valley-aaa'), 'Regulation VI', 'Regular Season Baseball Pitching Rules', $body$(a) Any player on a regular season team may pitch. Exception: Any player who has played the position of catcher in four (4) or more innings in a game is not eligible to pitch on that calendar day. A player who played the position of catcher for three (3) innings or less, moves to the pitcher position, and delivers 21 pitches or more (15- and 16-year-olds: 31 pitches or more) in the same day, may not return to the catcher position on that calendar day.
(b) A pitcher once removed from the mound cannot return as a pitcher. Intermediate (50-70) Division, Junior League, and Senior League only: A pitcher remaining on defense in the game, but moving to a different position, can return as a pitcher anytime in the remainder of the game, but only once per game.
(c) The manager must remove the pitcher when said pitcher reaches the limit for his/her age group as noted below: League Age 6-8: 50 Pitches, League Age 9-10: 75 Pitches, League Age 11-12: 85 Pitches, League Age 13-16: 95 Pitches.
(d) Pitchers league age 14 and under rest requirements: 66 or more pitches - four (4) calendar days of rest; 51-65 pitches - three (3) calendar days; 36-50 pitches - two (2) calendar days; 21-35 pitches - one (1) calendar day; 1-20 pitches - no rest required. NOTE 1: Under no circumstance shall a player pitch in three (3) consecutive days.
Pitchers league age 15-16 rest requirements: 76 or more pitches - four (4) calendar days of rest; 61-75 pitches - three (3) calendar days; 46-60 pitches - two (2) calendar days; 31-45 pitches - one (1) calendar day; 1-30 pitches - no rest required. NOTE 1: Under no circumstance shall a player pitch in three (3) consecutive days.
(e) Each league must designate the scorekeeper or another game official as the official pitch count recorder.
(f) The pitch count recorder must provide the current pitch count for any pitcher when requested by either manager or any umpire.
(h) Violation of any section of this regulation can result in protest of the game in which it occurs.
(k) Pitching in more than one game in a day: Minor League, Little League (Majors), and Intermediate (50-70) Division - A player may not pitch in more than one game in a day; Junior League and Senior League - A player may be used as a pitcher in up to two games in a day.$body$, 'baseball');


-- ------------------------------------------------------------
-- 5E. BAMSBL — 59 rules, all sport = 'baseball'
-- (fallback_to field from JSON dropped; represented by
--  leagues.parent_league_id = mlb)
-- ------------------------------------------------------------

INSERT INTO rules (league_id, rule_number, title, body, sport) VALUES

((SELECT id FROM leagues WHERE slug='bamsbl'), 'Fairness Doctrine', 'Fairness Doctrine', $body$The Board and President of the BAMSBL shall have the authority to oversee all player, team, and coach transactions. The Board has a duty to ensure that fair competition will prevail for the player(s), team(s) and the League as a whole.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), 'Appeal of any sanctions, suspensions or terminations', 'Appeal of any sanctions, suspensions or terminations', $body$As set forth in the Bylaws, any party disciplined, sanctioned, suspended or had its' membership terminated shall have the right to an appeal. Said party may submit a written statement to the BAMSBL Board not less than five days before its effective date, showing cause as to why said disciplinary action should be overturned, lessened, or modified. The President of the BAMSBL will rule on the appeal. Said President, at his choosing, may elect to defer his decision to a vote by the BASMBL Board, or form a grievance committee to make recommendation as to the disposition of the appeal.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), 'Authority for the BAMSBL Board and/or BAMSBL President', 'Authority for the BAMSBL Board and/or BAMSBL President', $body$As set forth in the Bylaws of the Bay Area Men's Senior Baseball League, which are registered and on file as the By Laws of Bay Area Men's Senior Baseball League, Inc. with the State of California, the President and/or the Board shall have and exercise the authority to discipline any League members for any conduct or actions deemed "inimical to the best interests of the corporation". This shall include any actions, intentional or otherwise, to violate, circumvent or evade any League rules, reasonable intent of the League rules, proven intent of the League rules, historical League practices or League precedents. This shall also include direct or indirect violations of Board or President Directives. Said disciplinary measures may include but are not limited to suspension of League membership, termination of League membership or any League sanctions set forth as determined by the BAMSBL Board to apply to the specific case. The Board shall notify any affected member(s) of any disciplinary actions at least 15 days prior to the effective date said disciplinary actions are to take place.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '105', 'Age Minimum 18+, 30+, 45+ and 60+ Divisions', $body$A. Players who turn 18, 35, or 50 prior to 11:59 p.m. on December 31 are eligible to play in the BAMSBL. Any player that turns 18, 35, or 50 during the calendar year is eligible to play the entire season. B. Any game(s) played with player(s) underage shall be deemed immediately forfeited by that team. The player(s) involved will also be ineligible for the duration of the current season. C. A manager has the right to demand to inspect the identification of any player on the field, before, during or after an official BAMSBL game. Until the player produces acceptable identification, said player in question will not be allowed to participate in said game or any future games. Acceptable identification is defined as: a valid driver's license, valid passport, valid Federal or State Government ID card or any identification which the umpire accepts as valid identification. D. Should the requesting manager still not be satisfied or agree with the authenticity of the identification presented, the said manager will immediately (within 24 hours) file a protest to the League Office for review. E. If any sanctions are applied, the normal appeal process will apply. F. The League President reserves the right to grant age waivers on a case-by-case basis, when presented with a compelling reason to do so.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '110', 'Team Fees and Payment to the League', $body$A. Full Balance must be paid by June 30th with agreement by Treasurer or Board by April 15th. B. If payment is not made in full by June 30th, or a specific agreement with the Treasurer or Board is not made by the June 30th deadline, then effective immediately the team will not be allowed to play. C. Once the payment or an agreement is made, a team will be allowed to play on the league's field. D. Any team which does not keep an agreement with the League to pay will not be allowed to play.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '115', 'Applicant Eligibility', $body$An applicant is eligible to participate in league-sanctioned tryouts if they have met the following requirements: A. Will turn 18 years of age during the calendar year and has means to verify it. B. Has completed the necessary league registration form(s). C. Is available to play on any team that exists in the region and age bracket for which they qualify.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '120', 'Free Agent Eligibility', $body$A. Unlimited number, however, no BAMSBL members in the same division as the previous year are eligible. 1. A player can be a free agent in two different age divisions. B. Has completed the required registration/waiver form(s) C. Has provided the team manager with a registration form. D. Has been put on the team roster for other team managers to verify the player's eligibility. Any team that has not verified the player has signed the required waiver form(s) and posted the player on their public roster before said player takes the field will forfeit their exclusive rights to that Free Agent in the same division. E. The presiding league Board of Directors must approve any exceptions or deviations from the Free Agent Eligibility requirements.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '125', 'Draft Eligibility', $body$A player is eligible for the BAMSBL draft pool if they have met the following criteria: A. Has attended and participated in one sanctioned Spring Workout for each division the candidate desires to play in (this can be waived by consent of all managers respective to their division) and followed the tryout program given by the Spring Workout Division Representative. B. Has presented a valid photo ID indicating at least 18, 35, or 50 years of age by the end of the year. C. Has completed registration/waiver form.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '130', 'Player Eligibility', $body$A player is eligible to participate in league play if they have met the following requirements: A. Has paid in full the current Team membership fee. B. Has been properly drafted, traded, or selected as a free agent according to league rules & guidelines. C. Has returned as a veteran player or was an eligible player on same team the previous year. D. Is properly attired. E. Is not currently serving a league suspension or game ejection. F. Is a BAMSBL member in good standing as defined by the BAMSBL Articles of Incorporation.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '140', 'Pool Players', $body$From time to time, we hear from players who have heard about our league, but never played in the BAMSBL. Sometimes they will contact league presidents or the commissioner about playing in our league after the season has started. Also, some of these players may have been in the Tryouts and not Drafted. League presidents will put all of them into a "Players Pool" for future consideration by team representatives. Pool Player may be added to a team to adjust the roster so as not to forfeit due to a lack of players. A. A League President will keep a list of Pool Players as the season progresses. C. The league president will control who is called and when, to follow up and see if the player actually gets on a team.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '145', 'Trades', $body$The BAMSBL sanctions the following types of trades: A. Interdivisional Between teams within own division 1. Player for player 2. Player for current draft pick(s) 3. Current draft pick for current draft pick 4. Trade for future draft pick(s) No outside compensation will be allowed for consummating a trade. B. Trades between age groups (Leagues) If players are traded between different Division teams, said players would be eligible only if the requisite minimum number of games is met by the players with their respective new teams, and they meet 18+, 30+, 45+ or 60+ age requirements. The established trading deadline will still apply. C. All trades must be approved by: 1. All involved parties 2. Both managers 3. League President$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '150', 'Trading Deadline', $body$The trade deadline is after the completion of the eighth (8th) scheduled game. No trades can be made after this time.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '155', 'Veterans Choosing Not to Return to Same Team', $body$Veterans who choose not to return to their current team at the end of each season, a player may choose not to return to their current team. The player has three (3) options: A. Re-enter the draft. Players must notify team managers and attend 1 sanctioned spring tryout. B. Request a trade (see rule 145). Requests must be made through the current team manager. C. If a player sits out a full season, they have the option to become a free agent. A current player is not eligible to join another team via free agency. Once a current player has stepped on the tryout field, they are no longer eligible to return to their former team, unless they choose to draft him.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '160', 'Dissolution of Teams', $body$Teams shall be declared dissolved only after the following steps have been taken: Coach or voted representative of affected BAMSBL team informs their BAMSBL League President, BAMSBL League Representative or BAMSBL President that said team has no one on roster willing to take over the responsibilities of a coach for the upcoming season. Said affected League Representative shall try and explore all options available to find a coach for the affected team. If no coach can be found, then said Board may declare the team as a dissolved team. Coach of dissolving team is prohibited from coaching another team for that year without the express approval of said Board. If such actions can be proved or has the reasonable appearance of a violation of the above procedures or rules as determined by said Board, than teams, coaches and the player(s) involved may be subject to disciplinary measures including (but not limited to) censure and/or suspension.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '165', 'Anti-Merger Rule', $body$No teams may be allowed to merge with other teams without the express approval of the BAMSBL Board. Said Board must approve of such a merger via simple majority vote.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '170', 'Anti-Raiding Rule', $body$Teams and/or their coaches of the BAMSBL are prohibited from conspiring, colluding, or attempting (intentionally or unintentionally), to raid other team rosters, or cause teams (including their own) to dissolve for the purpose of forming new teams.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '175', 'Anti-Collusion Rule', $body$Teams and/or their coaches of the BAMSBL are prohibited from conspiring, colluding, or attempting (intentionally or unintentionally) to circumvent rules (written or unwritten), practices (written or unwritten) or precedents (written or unwritten). The BAMSBL Board and the President shall have sole discretion of determining if the teams or coaches of said teams have violated any of the either in the present or future. If such actions can be proved or has the reasonable appearance of a violation of the above as determined by said Board, then teams, coaches and any player(s) involved may be subject to disciplinary measures including (but not limited to) censure and/or suspension.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '180', 'Anti-Tampering Rule', $body$BAMSBL teams and/or their coaches are prohibited from conspiring, colluding, or attempting (intentionally or unintentionally), to raid other BAMSBL team rosters for the purpose of filling their own roster or another team's roster. This includes (but is not limited to) suggesting or encouraging (intentionally or otherwise) players to quit their teams for the purpose of going into the draft so that they may be selected by a team or its coach encouraged said player move. If such tampering can be proved or has the reasonable appearance of tampering as determined by said Board, then teams, coaches and the player(s) involved may be subject to disciplinary measures including (but not limited to) censure and/or suspension.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '185', 'Manager Responsibility Rule', $body$1. A team manager must perform his managerial duties with the utmost conduct that is supportive to the welfare, interest, reputation, and charter of the BAMSBL. Including: proper on-field conduct with umpires, teammates, opponents, and guests in attendance. A. The League board may discipline a manager who fails to adequately maintain a current phone and email address; repeated failure to respond and participate in requested league communications; history of tardiness when reporting scores and statistics; misappropriation of team fees; history of delay when paying team fees to the league and any other action or behavior that is detrimental to the league. 2. Each team is required to report the final score of their game by 6 pm, or at the conclusion of that day's game if played late in the day. Each team is also required to submit complete game statistics (batting and pitching) to the league website by 9 pm the following Tuesday. 3. If a team has not posted its statistics within 10 days of a completed game, the team will lose 1 point in the standings for the first offense. For the second offense in a season, the team will lose 2 points in the standings. For the third offense in a season, the team will not be eligible for postseason play. 4. The League board may remove a manager from his managerial duties for conduct that is determined to be prejudicial and not in the best interest of the league.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '205', 'Spring Tryouts', $body$One of the primary goals of BAMSBL, Inc. is to provide an opportunity for interested individuals to play amateur baseball. We make this opportunity available through annual spring tryouts. Whether by league expansion, replacement of retired/non-returning players, or other means, the league attempts to leave no applicants behind. Managers or coaches will represent teams in need of new players, and they will observe and evaluate the skill level, hustle, and attitude of each applicant at the tryout. The spring tryouts are usually held beginning in mid-February, over the course of up to 2-3 weekends, weather permitting. All eligible applicants must put forth their reasonable best efforts during the official spring tryout. The eligible applicant must also declare and perform all components of the positions they plan on playing during the season. They include: Batting, Fielding (infield & outfield), Running, Pitching, Catching. If a pitcher or catcher fails to declare & perform for the managers/coaches, they will NOT be permitted to pitch or catch during the regular season or playoffs.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '210', 'Failure to Extend Best Efforts', $body$A. All eligible applicants are required to put forth all reasonable best efforts during the sanctioned spring tryout. If an applicant is judged by at least 3 managers/coaches to have not expended, in their view, a best effort, then that applicant will not be eligible for the draft. B. If during the season (regular or post), it becomes apparent to at least 3 managers in the player's division that they did not expend reasonable best efforts during the spring tryout, said player may be subjected to suspension or expulsion, and the player's team may suffer forfeiture of any games in which the player participated.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '215', 'The Draft', $body$A. All managers within their respective divisions meet to select eligible applicants. B. At the draft meeting, each team, to fill its roster requirements, selects a pre-determined number of applicants in a pre-determined order. Usually, the order is determined by the final standings from the previous regular season. In reverse order of finish, the teams select an applicant round-by-round, until all rosters are full, or all applicants have been exhausted. C. The presiding league Board of Directors must approve any exceptions or deviations from the draft requirements. D. Forfeits & Won Loss records: For the purpose of determining draft positions between teams with identical won-loss records, a team cannot count as a loss any forfeits they incur the previous season. E. Tiebreaker Rule: If the total wins of two or more teams are the same, the tiebreakers will be: 1. Head-to-Head Competition 2. Division Record 3. Inter-Division Record 4. Difficulty of Schedule$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '305', 'Uniforms', $body$All teams participating in BAMSBL sanctioned games must meet league uniform requirements. Every player must have a number on the jersey, matching caps, pants & jerseys in presentable condition for each regular season and playoff game. Each team has until the 4th league game to get all their players (drafted or traded) properly attired.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '310', 'Cleats/Spikes', $body$Players may wear metal, plastic or rubber baseball or softball cleats/spikes. Rubber sole shoes, or rubber baseball cleats are required on synthetic turf fields. Metal cleats cannot be worn on synthetic turf unless otherwise specified.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '315', 'Helmets', $body$A. All batters must wear a helmet with at least one (1) earflap (facing the pitcher) when batting. If a player wishes to wear a non-flap shell helmet, he must sign the required league waiver prior to any league participation. B. All base runners must wear a helmet. Earflaps are optional. C. Catchers must wear either a catcher's helmet or protective skullcap when catching. If a catcher wishes not to wear a helmet, he must sign the required league waiver prior to any league participation. D. All base coaches must wear a protective helmet or skullcap.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '320', 'Wood Bats', $body$We are a wood bat League. Only wood bats may be used during league play. Approved graphite, or composite bats may also be used during league play.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '325', 'Baseballs', $body$A. Only league-approved baseballs may be used during league play. These baseballs are designated "game" balls and handed out to managers by the league prior to the start of the season. B. Each team is required to supply 4 balls per game. The umpires will return unused balls. C. If the supply of balls becomes exhausted during play, either managers or presiding umpires may use a previously used approved ball upon consent.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '330', 'Pitcher''s Uniform', $body$Pitchers cannot wear white or gray sleeves, batting gloves, sweat bands, jewelry or other distracting items while on the mound.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '335', 'Failure to Adhere', $body$Failure to adhere to the requirements listed in this section could lead to player and/or manager ejection and/or suspension, and/or team forfeiture of games in which infractions occur.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '401', 'Field Dugout Designation', $body$The Home team on the official schedule shall occupy the 3rd base dugout at all games. A. The Visiting team shall occupy the 1st base dugout.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '405', 'Length of Game', $body$A. Nine (9) innings or 3 hours. No new inning is allowed to start after 3 hours. B. Mercy Rule: There is no mercy rule. All games shall be played until completion or the end of 3 hours.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '410', 'Start of Game', $body$A. Game time begins with the scheduled time. If a game is supposed to start at 10 a.m. but does not begin on time due to reasons other than field conditions, weather conditions (or other act of God), or late umpires, then the 3-hour time limit starts at 10 a.m. regardless of when the game starts. B. Each team must have a minimum of 8 eligible players present, in full uniform and ready to play, no less than 15 minutes after the scheduled starting time, or a forfeit will be declared. In the batting lineup, when batting position #9 comes up, an automatic out will be recorded. The #1 batter will bat. If a legal player arrives to the game, they will be inserted into the #9 slot, and it will no longer be recorded as an automatic out. C. A team may reduce its lineup to seven (7) (offense & defense) only because of injury incurred during the course of a game. The injured player & manager must report such injury to the Home Plate Umpire before leaving the playing field. The umpire shall determine if the injury is legitimate and warrants leaving the game. In the event of such an occurrence, the batting order remains the same, but an OUT is recorded each time the injured player is due to bat.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '415', 'Forfeit Rule', $body$The purpose of the Forfeit Rule is to limit the number of forfeits a team can have in a season. A. Each time a team forfeits a game, besides a loss, the team will automatically lose one (1) point in the standings. B. The Board will give serious consideration to expelling a team from the league who forfeits more than two games in a season. C. Teams that forfeit on game day more than once during the course of a season will need Board approval to rejoin the league the following season. D. Any team that forfeits more than once, and allowed to return to the League will be required to post a refundable deposit of $300. This deposit will be used to pay for umpires and the field in the event said team forfeits a game during the subsequent season. E. If a team does forfeit their deposit because of a forfeit, they will be required to post another $300 deposit before the next week or game they play, if they intend to continue team play for the rest of the season. The deposit will be held over to the next season if the team returns. F. If a team does not forfeit during the subsequent season, the deposit will be returned to the team manager at the end of the season. G. A team that forfeits before 5:00 PM on the Thursday prior to a Sunday game (Wednesday prior to a Saturday game) will not have to give up their deposit. H. The players on a team that forfeits during the season will not receive credit towards Playoff Participation in the same season.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '420', 'Batting Line-up', $body$A. Batting and fielding line-ups operate independently of each other. Each team may bat as many as it chooses provided there is a minimum of eight (8), but if nine (9) or more players are present for a game then a minimum of nine (9) players must always be in the line-up. If only eight (8) players are in the lineup, then each time the 9th spot comes around in the lineup it shall be an automatic out. Professional Baseball rules governing "Batting out of order & Illegal Substitution" still apply. B. Managers shall, prior to each game, supply the opposing manager with a batting order that includes batters that will be provided with courtesy runners. Player's jersey numbers should be included. C. Any batting change must be announced to the opposing manager, coach/assistant or official scorekeeper prior to the change being made. Umpires need not be notified. The batting line-up may only be changed in the following manners: 1. PINCH HITTER 2. ADDITIONAL HITTERS 3. REMOVED HITTER 4. A/B - ALTERNATING HITTERS 5. If a player is ejected from the game by the umpire, each time his position in the lineup comes around it will be considered an automatic out, unless a pinch hitter is available and inserted into the game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '425', 'Fielding Line-up', $body$A. Fielding and batting line-ups operate independently of each other. All substitutions made on defense are unrestricted, except for the pitcher. Any player who departs or is removed from the position of pitcher may return to pitch only once, but not until, at the very earliest, the next new inning, following his initial departure from the mound.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '430', 'Courtesy Runners', $body$A. Teams with nine (9) batters are permitted two (2) courtesy runners. Teams with eight (8) batters are permitted one (1) courtesy runner. Prior to the start of each game, managers have the option to designate the batters who require "courtesy substitute base runners", after reaching base. B. Each respective "courtesy base runner" will be the player who has made the last batted out. If no last batted out hitter is available to run (1st inning), then the duty goes to the last batter listed in the line-up. C. A "courtesy base runner" must be inserted immediately, and before play resumes. If the "courtesy base runner" is not inserted immediately, (by the next pitch), then the designated player loses his "courtesy base runner" privilege until their next plate appearance.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '435', 'Injured Base Runner', $body$If a player is deemed injured by the home plate umpire and is unable to fulfill their duties as a base runner, a "courtesy base runner" (last batted out) will be permitted. The injured player is then permanently removed for the duration of the game.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '440', 'Catcher 2-out base runner', $body$When 2 outs exist in any inning and the catcher is on base, a "courtesy base runner" must be immediately inserted (last batted out). This rule only applies to the catcher. This will allow each team to adhere to the 2-minute rule. (See rule #445)$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '445', 'Two (2) minute rule', $body$Each team has two (2) minutes from the recording of the last out in the previous half inning to get ready for the next half inning. This time includes pitcher, infielder & outfielder warm-ups.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '455', 'Last Weekend of Regular Season (Elimination Game)', $body$In the event an elimination game is required the following will be adhered: Games played in the last week (Week 16) of the "regular season schedule" are guaranteed for all players who qualify by league rules. It will be an elimination game, and not part of the regular playoff series. All rules for the regular season will apply. Playoff series do not begin until all teams in both leagues have played a "regular season schedule" (16 games), or a "regular season schedule" as determined by the Board.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '465', 'Failure to adhere', $body$Failure to adhere to the requirements in this section could lead to player and/or manager ejection, suspension and/or team forfeiture of games in which the infractions occur.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '470', 'Protesting Games', $body$The League shall adopt rules governing procedure for protesting a game, when a manager claims that an umpire's decision is in violation of these rules. Rules of the game when not posted in the BAMSBL Handbook will be the standards followed by Major League Baseball. No protest shall ever be permitted on judgment decisions by the umpire. In all protested games, the decision of the League President shall be final. However, a manager may appeal the decision of the League President to the League Board of Directors. A decision will be made within 24 hours of receiving the appeal. Whenever a manager protests a game because of alleged misapplication of the rules the protest will not be recognized unless the umpires are notified at the time the play under protest occurs and before the next pitch is made or a runner is retired. A protest arising on a game-ending play may be filed until noon the following day with the League President.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '505', 'Collision/Obstruction', $body$This rule is not a "must slide" rule but, a "no collision" rule. All runners must either slide, legally avoid the tag or give up their right to a base (avoid a collision by stopping/leaving the base path), if the Defensive players have clear possession of the ball. When advancing to a base or the plate, the runner must avoid intentional forceful contact to jar the ball loose from the fielder, injure the fielder, or employ, in the judgment of the umpire, an "illegal slide."
A. Specifics for Rule 505:
1. Any runner is out when the runner does not legally slide and causes illegal contact and/or illegally alters the actions of a fielder in the immediate act of making a play; or on a force play, does not slide in a direct line between the bases.
2. A legal slide can be either feet first or headfirst. If a runner slides feet first, at least one leg and buttock shall be on the ground. A. If a runner slides, the runner must slide within reach of the base with either a hand or a foot. B. A runner may slide or run in a direction away from the fielder to avoid making contact or altering the play of the fielder.
3. PENALTY for an illegal slide: The runner is out. Interference is called and the ball is dead immediately. On a force-play slide with less than two outs, the runner is declared out, as well as the batter-runner. Other runners shall return to the bases occupied at the time of the pitch. With two outs, the runner is declared out and the batter is credited with a fielder's choice.
4. MALICIOUS or flagrant contact always supersedes obstruction. In addition, unless the fielder/catcher is in possession of the ball, the fielder/catcher cannot block the pathway of the runner as they are attempting to advance.
5. If, in the judgment of the umpire, the fielder/catcher without possession of the ball blocks the pathway of the runner, the umpire shall rule "obstruction" and call or signal the runner safe.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '510', 'Decoy Rule', $body$A fielder may not use a decoy to force a player into a dangerous situation. For example, if a fielder fakes a tag, forcing a player to slide, when there is no strategic purpose or apparent play, the runner will be ruled safe, and all runners will advance one base. This is entirely an umpire judgment decision and not a rule that may be protested.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '520', 'Intentional Walks and Hit Batsmen', $body$A. Each team is allowed to intentionally walk an opposing team player once in a game. Therefore, the total number of intentional walks each team is allowed each game is one (1). The umpire will send the batter to first base when the opposing manager indicates he wants to walk the batter. 1. If a team attempts an intentional walk twice in a game, the home plate umpire must stop play and have the catcher resume his defensive position behind the plate. A balk will be called and any runners on base will advance one base. The count will also be restarted at 0-0. B. If a pitcher hits four (4) batters in one game, the pitcher must be removed. 1. No pitcher shall intentionally throw at a batter in either the batter's box or in the batter's on-deck circle. If, in the judgment of the presiding umpires, the pitcher intentionally throws at the batter, said pitcher will be immediately ejected from the game and will be subject to further league action.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '525', 'Abuse of Umpires', $body$Any of the following actions can result in a player being ejected from a game, with possible suspension from additional games: A. Pushing an umpire or intentionally blocking an umpire's movement B. Sustained arguing of an umpire's decision. C. Using abusive, profane, threatening, or obscene language or gestures D. Throwing a bat, glove, helmet, or other equipment in anger E. Creating a disruptive, threatening, or dangerous situation$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '530', 'Un-Sportsmanlike Conduct', $body$Anything constituting Un-SPORTSMANLIKE CONDUCT will not be tolerated. Examples include, but not limited to: A. Fake tags & deaking runners. B. Throwing equipment in any careless, dangerous, or malicious manner. C. Swearing at anyone in attendance: Players, Umpires or Fans/Spectators. D. Taunting or any other displays of disrespect for person, property, or the game of baseball itself. E. No player shall charge another player on or off the field. F. In the case of A & C, a warning shall be issued at the very least. G. In the case of B, D, & E offending player(s) shall be ejected with the possibility of suspension upon umpire's recommendation.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '532', 'Fan/Spectator Un-Sportsmanlike Conduct', $body$Anything constituting UN-SPORTSMANLIKE CONDUCT will not be tolerated. Examples include, but not limited to: A. Throwing projectiles (containers, food, equipment, etc.) in any careless, dangerous, or malicious manner onto the field or at the players. C. Swearing at anyone in attendance: Players, Umpires, or other Fans/Spectators. D. Excessive Taunting of Players, Umpires, or any other displays of disrespect for person, property or the game of baseball itself. E. No fan/spectator shall charge another fan/spectator or player on the field, in the viewing stands, or parking lot. F. In the case of C & D, at the very least a warning shall be issued by the umpire and/or team manager if both agree to do so. G. In the case of A, D, & E offending fan/spectator(s) shall be ejected from the venue when the umpire and/or team manager agree to do so. H. If after being requested to do so, a fan/spectator refuses to leave the stands, a team may decide not to take the field. The game will be delayed or postponed.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '535', 'Player Suspension', $body$A. A player who is ejected will receive an automatic suspension from the next official game. All-Star or tournament games will not be considered official games for purposes of serving out the suspension. Only games that affect league records/standings or playoff games will be used to serve out the suspension. Suspension may be carried over to next season if necessary. B. A suspended player will have his case reviewed by the League President, who may decide upon further review that additional disciplinary action, is warranted. 1. If the umpire deems the action by a player's ejection was "very serious," said player may be suspended up to 3 games by the President or Board of Directors. C. Manager of the offending player is required to submit a report with 24 hours regarding the incident. The manager will face a suspension of at least 1 game for not reporting an incident.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '540', 'Suspension Appeal', $body$The suspended individual may appeal any disciplinary action taken by the league. This appeal must be made in writing and submitted to the League President. Once notified, the League President has 48 hours to review the appeal and render a decision. If the individual, upon receiving this decision, still disagree, they may appeal the decision to the Board of Directors. A decision will be made within 24 hours of receiving the appeal. The President and/or Board's decision is final.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '545', 'Alcohol & Cannabis', $body$Possession or consumption of Alcoholic Beverages and Cannabis products is strictly forbidden at any high school, college, university, or public park & recreation location used by the BAMSBL. Furthermore, it is AGAINST THE LAW! The only beverages other than water permitted at any location are milk, juice, sport, or soft drinks. Any offender of this policy will: A. Be suspended for the baseball season. If offender(s) are caught after the 14th league game, said offender(s) will be suspended through the next season. B. Offender(s) subject to revocation of local and national MSBL membership and possible criminal action. Teams that fail to comply and/or fail to properly identify any conspicuous offenses will also be subject to: 1. Forfeiture of game on date of the offense. 2. Suspension of presiding manager. 3. Team permanently banned from using field where offense occurred.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '550', 'Smoking', $body$Smoking cigarettes, cigars, electronic devices or any other substance is strictly forbidden on any playing field or dugout.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '555', 'Pets', $body$Pets are forbidden on any playing area and dugout. Pets are permitted in the spectator area, but must be confined to a leash, with a responsible person controlling the animal. Failure to comply with this requirement may lead to suspension, revocation of league membership, criminal citation and/or civil damage claim.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '601', 'Playoff Eligibility Requirements', $body$1. The player must participate in at least six (6) games. 2. Participation is defined in the following ways: A. The player has had at least two (2) plate appearances in the game for participation. B. The player has pitched and recorded a minimum of three (3) outs in the game. C. Proof of participation must be done by posting statistics on the league official stats website. If no statistics appear on the website for all managers to view before the playoff games begin, there shall be no player participation credited. 3. Injury Exclusion and Waiver (adopted January 2019) A. No participation credit for games missed due to injuries on or off the field during the regular season shall be granted to a player towards eligibility in the postseason playoffs. 4. When a game is forfeited during the regular season, all players on the winning team shall be deemed as having played in a game for the purpose of player playoff game eligibility.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '603', 'Playoff Rosters', $body$1. It is the responsibility of each manager to post a "playoff roster" of eligible players within 24 hours of the final regular season game. 2. It is the responsibility of an opposing manager to review the "playoff roster" of their opponent to determine if the roster they are reviewing is eligible. A. If the manager determines there is an ineligible player on the roster, the opposing manager must report to the Board said player no later than Wednesday prior to the playoff game. B. The Board will determine eligibility based upon Rule 601. Board determination of eligibility will be final. 3. If no appeal to the Board is made as stated above, the right to appeal shall be declined by the Board. There will be no "game day" appeal for eligibility. 4. A team will forfeit their game if it is determined by the Board that a player has played in a playoff game when ineligible to participate on the roster.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '605', 'Tiebreaker Formula', $body$The following formula shall be used by the BAMSBL when determining tiebreakers for teams eligible for annual league playoffs: A. Head-to-head matchups: record against team tied with. B. Final record against division teams. C. Run differential against team tied with. D. Runs allowed: Team giving up least amount of runs against division opponents. E. Coin flip: 1. The President will conduct the coin flip procedure. The President will attempt to have all concerned parties present, either physically or by electronic means. 2. If one or both managers are not present, then a Board member(s) will represent the teams. The President will flip the coin. The results cannot be appealed.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '610', 'Home Team Designation', $body$Home team designation will be granted to the team with the best overall won-lost record. In the event of a three-game series, the home team designation will alternate from game to game. A. In the event both teams have the same won-lost record, see rule #605 for tiebreaker.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '615', 'Playoff Player Participation', $body$Participation Requirements in the actual Playoff Game do not apply. Therefore, players will NOT be required to have a plate appearance or an appearance in the field.$body$, 'baseball'),

((SELECT id FROM leagues WHERE slug='bamsbl'), '620', 'Playoff Game Limits', $body$There will be NO time limit on playoff games. However, the 10-Run Mercy Rule will be in effect. After 7 innings are completed, if a team has a lead of 10 runs or more, the game will be ended by the umpires and the team score leader will be declared the game winner.$body$, 'baseball');


-- ============================================================
-- PART 6: VERIFICATION QUERIES
-- Run these after the INSERT statements to confirm row counts.
-- ============================================================

-- Expected: 5 leagues
SELECT slug, name, is_foundation,
       (SELECT slug FROM leagues p WHERE p.id = l.parent_league_id) AS parent_slug
FROM leagues l
ORDER BY is_foundation DESC, slug;

-- Expected row counts per league:
-- mlb: 20 | little-league: 18 | usssa: 5 | mill-valley-aaa: 37 | bamsbl: 59
SELECT l.slug, COUNT(r.id) AS rule_count
FROM leagues l
LEFT JOIN rules r ON r.league_id = l.id
GROUP BY l.slug
ORDER BY l.slug;

-- Confirm the 1.10 softball/baseball split worked (should return 2 rows)
SELECT rule_number, title, sport
FROM rules r
JOIN leagues l ON l.id = r.league_id
WHERE l.slug = 'little-league' AND r.rule_number = '1.10'
ORDER BY sport;

-- Confirm UNIQUE constraint is working: this should return 0 conflicts
SELECT league_id, rule_number, sport, COUNT(*) AS cnt
FROM rules
GROUP BY league_id, rule_number, sport
HAVING COUNT(*) > 1;

-- ============================================================
-- END OF MIGRATION FILE
-- Next step: run embed-rules equivalent against Supabase to
-- populate rule_embeddings via SELECT into the new tables.
-- ============================================================

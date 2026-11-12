/**
 * Scripted performances for the simulated demo choir.
 *
 * Each script is one canonical answer with contested slots where the simulated
 * voices' temperaments pull in different directions. Every option is written
 * so the sentence still reads whichever option wins, because the mix (or a
 * user's fork) can pick any of them. See script.ts for the template syntax.
 *
 * Temperament letters: c cautious, b blunt, t techno-optimist,
 * k community/tradition, l legalistic.
 */
import { parseTemplate, type Script } from "./script";

export const SCRIPTS: Script[] = [
  parseTemplate(
    "refuse",
    "Should AI models be allowed to refuse requests?",
    "Yes[, within limits@cl| — but rarely@bt|, and often@k]. A model that[ can never| is never allowed to@l| will never@b] say no can be[ turned into| used as@b| made into@l] a tool for[ harm| abuse@l| fraud@b], but one that[ refuses| says no@b] too often[ becomes useless@bt| fails the people it serves@k| treats every user as a suspect@t]. The[ line| test@l| bar@b] should be[ the risk of serious harm@c| clear, published rules@l| what a decent person would refuse@k| real, concrete danger@bt], not[ embarrassment@b| vague discomfort@c| politics@t]. When a model does refuse, it[ should| must@l| ought to@k] say why and[ point to| suggest@t| offer@k] a better path[.| where it can.@c]",
    { keywords: ["refuse", "refusal", "refusing", "decline", "say", "no", "requests"] },
  ),
  parseTemplate(
    "promise",
    "Is it ever right to break a promise?",
    "Yes, though[ rarely@c| only for a weighty reason@l| more often than people admit@b]. A promise[ creates| carries@l| is@b] a real obligation, because other people[ plan their lives@k| make decisions@l| build their plans@t] around it. But keeping a promise is not the[ highest| only@k| final@l] value: if keeping it would[ cause serious harm| hurt someone innocent@k| break the law@l| cost a better opportunity@t], breaking it can be[ the right thing@b| the lesser wrong@c| justified@l]. What[ matters| counts@l| makes the difference@k] is how you break it.[ Tell them early@b| Explain yourself honestly@c| Make amends@k| Offer what you can in its place@t], and treat the broken promise as a debt[ you still owe.| rather than a clean exit.@l| to the people who trusted you.@k]",
    { keywords: ["promise", "promises", "break", "breaking", "keep", "word", "ethics"] },
  ),
  parseTemplate(
    "decide",
    "Who should decide what an AI is allowed to say?",
    "No single[ company| government@t| group@c] should decide it alone. The[ companies that build models@l| people who use them@k| engineers@t] know[ things| details@l| a lot@b] the public does not, but they also have[ commercial interests| something to sell@b| blind spots@c]. A better[ answer| arrangement@l| model@t] is[ shared rule-making@l| layered@c| public debate@k]: laws set the[ outer| hard@b| basic@c] limits, independent[ auditors| reviewers@c| courts@l] check the[ claims| promises@b| practice@l], and[ communities| users@t| local institutions@k] get a say in what fits their own[ values| norms@l| traditions@k]. Whoever decides,[ the rules| the reasons@c| the rules and the reasons@l] should be public.",
    { keywords: ["decide", "decides", "say", "allowed", "censor", "censorship", "speech", "govern", "regulate", "rules"] },
  ),
  parseTemplate(
    "lie",
    "Is it okay to lie to spare someone's feelings?",
    "Sometimes[, but less often than we think@c|, for small things@b| — kindness matters@k]. A[ white lie| small lie@b| gentle untruth@c] about a haircut or a[ gift| new dress@k| bad poem@b][ costs little| harms no one@b| keeps the peace@k] and can[ protect| ease@c| honour@k] a moment that matters to someone. But lies[ add up| compound@b| erode trust@l], and people usually[ want| deserve@l| prefer@c] the truth about things that[ affect their choices| shape their lives@k| they can still change@t]. The[ better| kinder@k| harder@b] skill is[ honest tact@c| choosing what to say@k| telling the truth gently@b]: you can[ leave| keep@c] some things unsaid without[ saying| inventing@b| stating@l] anything false.",
    { keywords: ["lie", "lying", "lies", "white", "feelings", "honest", "honesty", "truth"] },
  ),
  parseTemplate(
    "city",
    "Describe the perfect city in two sentences.",
    "The perfect city is[ walkable| compact@l| green@k| quiet@c], with[ trees| parks@k| fast trains@t| bike lanes@b] on every[ street| corner@k| block@b], homes that[ ordinary| working@k| young@t] people can afford, and[ a square where neighbours meet| a market at its heart@k| public spaces that stay open late@t| clear rules everyone can see@l]. It[ runs on| is powered by@t| relies on@c] clean energy, and it[ changes| grows@t| adapts@c| evolves@b] without[ forgetting its history| losing its soul@k| pricing people out@b| breaking its own rules@l].",
    { keywords: ["city", "cities", "perfect", "ideal", "urban", "town", "describe"] },
  ),
  parseTemplate(
    "teacher",
    "What makes a good teacher?",
    "A good teacher[ knows their subject@l| cares about students@k| makes ideas clear@b], but[ more importantly| above all@b| just as much@c] they[ notice| see@b| pay attention to@c] who is[ lost| struggling@k| bored@t] and[ change| adjust@c| rethink@t] the lesson for them. They[ set| hold@l| keep@k] high standards[ without| while never@c] making students afraid to be wrong, and they[ give| offer@c| share@k][ honest| clear@b| specific@l] feedback[ quickly| often@b| kindly@k]. The best ones[ leave students with| send students off with@t| leave their students with@k][ curiosity| a habit of asking questions@t| confidence@b| a sense of belonging@k] that[ lasts| endures@t| stays with them@k] long after the exam.",
    { keywords: ["teacher", "teachers", "teaching", "teach", "good", "school", "education"] },
  ),
];

/** Played for prompts that match no script. Says plainly what the demo is. */
export const FALLBACK_SCRIPT: Script = parseTemplate(
  "fallback",
  "(unscripted prompt)",
  "This is the simulated demo choir, so[ it can only| it is only able to@l| all it can do is@b] perform the sample prompts. The[ voices| singers@k] here are[ scripted stand-ins| simulations@b| fictional voices@l], not real models, and they[ will not| cannot@b| should not@c] pretend to answer[ a new question| your prompt@b| an arbitrary prompt@l]. Add an OPENROUTER_API_KEY to the server's environment to[ hear| switch to@l| bring in@t] real models[ singing together.| from different labs.@k| voting token by token.@t]",
  { hidden: true },
);

const STOP = new Set(
  "a an the is it to of in on for and or but be are was were do does did should would could can will what who whom which how why when where ever okay ok i you we they me my your our their this that these those with about as at by from into than then so if not no yes".split(
    " ",
  ),
);

/** Lower-case content words of a prompt. */
export function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Pick the script for a prompt: exact match first, then keyword overlap
 * (at least two shared content words, or one when the prompt itself has only
 * one or two content words and the word is distinctive to one script).
 * Anything else gets the fallback script, which says plainly that the
 * simulated choir only performs the sample prompts.
 */
export function scriptForPrompt(prompt: string): Script {
  const n = norm(prompt);
  const exact = SCRIPTS.find((s) => norm(s.prompt) === n);
  if (exact) return exact;
  const words = contentWords(prompt);
  if (words.size === 0) return FALLBACK_SCRIPT;
  let best: Script | null = null;
  let bestScore = 0;
  let tie = false;
  for (const s of SCRIPTS) {
    const vocab = new Set([...contentWords(s.prompt), ...(s.keywords ?? [])]);
    let score = 0;
    for (const w of words) if (vocab.has(w)) score++;
    if (score > bestScore) {
      best = s;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  if (!best) return FALLBACK_SCRIPT;
  if (bestScore >= 2 && !tie) return best;
  if (bestScore === 1 && words.size <= 2 && !tie) return best;
  return FALLBACK_SCRIPT;
}

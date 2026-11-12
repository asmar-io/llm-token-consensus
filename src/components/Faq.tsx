import { ChevronDown } from "lucide-react";

/** Questions and answers shown on the landing page. Kept in step with the FAQ in README.md. */
const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "What is consensus inference?",
    a: (
      <>
        <p>
          A normal chatbot answer comes from one model, so one lab&apos;s training data and rules decide every word. In Chorus, several models from different labs are asked the same thing at the
          same time: &ldquo;given the answer so far, what comes next, and how sure are you?&rdquo; Their odds are blended into one, a single token is drawn from the blend, and the question is asked
          again for the next token.
        </p>
        <p>The answer is written jointly, one token at a time, and every vote is kept so you can inspect it.</p>
      </>
    ),
  },
  {
    q: "What is it useful for?",
    a: (
      <>
        <ul>
          <li>
            <strong>Seeing where models disagree.</strong> Most words are uncontroversial. The few where the voices split are where their training differs: values, emphasis, sometimes facts. The
            Agreement lens makes those words stand out.
          </li>
          <li>
            <strong>A cheap warning light.</strong> When independent models split on a name, number or date, that is a good place to check a source. It is a hint, not a fact-check: models can
            agree and all be wrong.
          </li>
          <li>
            <strong>Diluting any single lab&apos;s influence.</strong> On questions with no neutral answer, no one model gets to pick the framing alone.
          </li>
          <li>
            <strong>Comparing models on your own prompt.</strong> Mute or solo a voice, change its gain, and see who carried the answer and what each would have said alone.
          </li>
          <li>
            <strong>Asking &ldquo;what if?&rdquo;</strong> Fork from any alternative token and hear how one different word changes everything after it.
          </li>
          <li>
            <strong>A stricter filter.</strong> In Consensus mode a word only gets through if every voice finds it plausible, which removes one model&apos;s quirks.
          </li>
          <li>
            <strong>Teaching and research.</strong> It shows sampling, tokenisation and model disagreement directly, on real models.
          </li>
        </ul>
        <p>We have not measured whether blended answers are more accurate than a single model&apos;s. Treat the value as transparency, not as a smarter model.</p>
      </>
    ),
  },
  {
    q: "Mixture or Consensus: which blend should I use?",
    a: (
      <>
        <p>
          <strong>Mixture</strong> averages the voices&apos; odds. A word that one voice strongly wants can still win, so the text keeps more of each model&apos;s character. It is the default.
        </p>
        <p>
          <strong>Consensus</strong> multiplies the odds, so a word that any voice finds very unlikely is nearly ruled out. The text is more conservative, and the most confident voice tends to
          lead.
        </p>
      </>
    ),
  },
  {
    q: "How do I read the numbers on a token?",
    a: (
      <ul>
        <li>
          <strong>Mixed probability</strong>: how likely the blended choir found this token.
        </li>
        <li>
          <strong>Agreement</strong>: 1 means the voices&apos; predictions were the same; lower means they were split.
        </li>
        <li>
          <strong>Share</strong>: how much of the chosen token&apos;s support came from each voice. The voice with the largest share is shown as carrying it.
        </li>
        <li>
          <strong>Entropy</strong>: how many real options the blend had. Near 0 means there was one obvious choice.
        </li>
        <li>
          Voices cut words into pieces differently. When two voices want the same word but split it differently, the step reads as less agreed than it really was.
        </li>
      </ul>
    ),
  },
  {
    q: "Why is it slow, and what does it cost?",
    a: (
      <p>
        Every token needs one call to every voice, and each call re-reads the whole answer so far. Nothing can be streamed or cached the way a single model does it. With three voices, expect about
        two seconds per token and roughly one to three US cents for a short answer. Adding voices adds cost, and the slowest voice sets the pace.
      </p>
    ),
  },
  {
    q: "Why these models, and why are they all from Chinese labs?",
    a: (
      <>
        <p>
          A voice has to do two things that most hosted models do not: continue a half-written answer instead of starting a new one, and report its odds for the next token. We tested 456 model and
          provider combinations on OpenRouter in November 2026. Only DeepSeek, Kimi (Moonshot) and Qwen (Alibaba) models, on specific providers, passed both checks.
        </p>
        <p>
          Llama, Gemma, Mistral and GPT-4o were tested and start a fresh reply instead, which would corrupt the text. That is a limit of how those models are hosted today, not of the idea: any
          model you can run with raw access to its token probabilities could join.
        </p>
      </>
    ),
  },
  {
    q: "Is this decentralised?",
    a: (
      <p>
        Only in one sense: the decision about each word is spread across models trained by different labs. The app itself is an ordinary server that calls those models, so it is not decentralised
        the way a blockchain is, and nothing here is verified cryptographically.
      </p>
    ),
  },
  {
    q: "What happens to my prompt?",
    a: (
      <p>
        With a live choir, your prompt and the answer so far are sent through OpenRouter to the provider of each selected model, once per token. Chorus itself stores nothing on the server; takes
        live in your browser tab and are gone when you close it, unless you export them.
      </p>
    ),
  },
  {
    q: "What is the demo choir?",
    a: (
      <p>
        Without an API key, Chorus replays real performances that were recorded from the live choir. Every probability, vote, delay and cost you see is what actually happened in that run. A
        recording cannot answer a new prompt or fork; those need live calls.
      </p>
    ),
  },
];

export function Faq() {
  return (
    <section aria-labelledby="faq-h" className="max-w-2xl">
      <h2 id="faq-h" className="eyebrow mb-3">
        Questions
      </h2>
      <div className="overflow-hidden rounded-xl border border-line">
        {FAQ.map((item) => (
          <details key={item.q} className="group border-b border-line bg-raised last:border-b-0">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 text-[15px] font-medium text-ink marker:hidden hover:bg-sunk/60 [&::-webkit-details-marker]:hidden">
              {item.q}
              <ChevronDown size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="faq-body px-4 pb-4 text-sm leading-relaxed text-ink-2">{item.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

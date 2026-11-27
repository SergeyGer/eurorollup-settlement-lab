/**
 * Prompt construction for the live local model adapter.
 *
 * One structured response per attempt. The prompt contains synthetic rule
 * metadata and the short question only; it never contains credentials, portfolio
 * data or signing material. Output is additionally constrained by the proposal
 * decoding schema at the runtime level, then validated by the adapter.
 */
import type { LiveDraftRequest, ModelMessage } from "./types.js";

export const LIVE_PROMPT_VERSION = "p01-live-v10";

const FEW_SHOT_EXAMPLES = [
  {
    question: "What if the fund moved its Friday cutoff from 16:00 to 15:00 UTC?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC","expectedTimeUtc":"16:00"}',
  },
  {
    question: "What happens if Friday's cut-off becomes 14:00 UTC?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"14:00","timezone":"UTC"}',
  },
  {
    question: "Can we shift the eFUND Friday dealing cutoff to 09:00 UTC?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"09:00","timezone":"UTC"}',
  },
  {
    question: "Move the Friday cutoff for eFUND to 12:00 UTC.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"12:00","timezone":"UTC"}',
  },
  {
    question: "Change Friday's cutoff from 4pm to 3pm UTC.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC"}',
  },
  {
    question: "Set the bond fund Friday cutoff to one hour earlier than 16:00, at 15:00 UTC.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC","expectedTimeUtc":"16:00"}',
  },
  {
    question: "Shift the weekly fund cutoff on Friday to 07:00 UTC.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"07:00","timezone":"UTC"}',
  },
  {
    question: "Propose a Friday cutoff of 08:30 UTC for the euro fund.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"08:30","timezone":"UTC"}',
  },
  {
    question: "If the eFUND Friday cutoff is 15:00 UTC rather than 16:00 UTC, what changes?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC","expectedTimeUtc":"16:00"}',
  },
  {
    question: "We're considering a Friday cutoff of 10:00 UTC for the bond fund.",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"10:00","timezone":"UTC"}',
  },
  {
    question: "If we set the Friday fund cutoff to 13:00 UTC, what changes?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"13:00","timezone":"UTC"}',
  },
  {
    question: "Shift Friday's cutoff to a later time.",
    answer:
      '{"status":"clarify","question":"What new whole-minute UTC time should Friday subscriptions close at?","missingFields":["timeUtc"]}',
  },
  {
    question: "What if the cutoff is 15:00 CET?",
    answer:
      '{"status":"clarify","question":"Only UTC is supported. Which whole-minute UTC time should the cutoff use?","missingFields":["timezone"]}',
  },
  {
    question: "What if Friday subscriptions close at 14:45 UTC instead of 16:00 UTC?",
    answer:
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"14:45","timezone":"UTC","expectedTimeUtc":"16:00"}',
  },
  {
    question: "Change the eFUND NAV publication time to 16:00 UTC.",
    answer: '{"status":"unsupported","reasonCode":"UNSUPPORTED_OPERATION"}',
  },
  {
    question: "Move the cutoff earlier.",
    answer:
      '{"status":"clarify","question":"Which weekday and which new whole-minute UTC cutoff should apply?","missingFields":["weekday","timeUtc"]}',
  },
  {
    question: "Move the cutoff to 15:00.",
    answer:
      '{"status":"clarify","question":"Which weekday should the cutoff apply to?","missingFields":["weekday"]}',
  },
  {
    question: "Can we change the fund cutoff?",
    answer:
      '{"status":"clarify","question":"Which weekday and which new whole-minute UTC cutoff should apply?","missingFields":["weekday","timeUtc"]}',
  },
  {
    question: "What happens if subscriptions close later on Friday?",
    answer:
      '{"status":"clarify","question":"What new whole-minute UTC time should Friday subscriptions close at?","missingFields":["timeUtc"]}',
  },
  {
    question: "What if the Friday cutoff is 15:00 CET?",
    answer:
      '{"status":"clarify","question":"Only UTC is supported. Which whole-minute UTC time should the Friday cutoff use?","missingFields":["timezone"]}',
  },
  {
    question: "Change the redemption cutoff to 15:00 UTC.",
    answer: '{"status":"unsupported","reasonCode":"UNSUPPORTED_OPERATION"}',
  },
  {
    question: "Move the Monday and Friday cutoffs to 15:00 UTC.",
    answer: '{"status":"unsupported","reasonCode":"MULTIPLE_CHANGES"}',
  },
  {
    question: "Set the Friday cutoff to 18:00 UTC.",
    answer: '{"status":"unsupported","reasonCode":"OUT_OF_RANGE"}',
  },
  {
    question: "Move the Saturday cutoff to 15:00 UTC.",
    answer: '{"status":"unsupported","reasonCode":"UNSUPPORTED_WEEKDAY"}',
  },
  {
    question: "Move the cutoff to 12:00 UTC on the first Friday of each month.",
    answer: '{"status":"unsupported","reasonCode":"MULTIPLE_CHANGES"}',
  },
] as const;

export function buildSystemPrompt(): string {
  return [
    "You draft exactly one typed policy proposal for a synthetic euro settlement sandbox. Reply with one JSON object only. You never calculate outcomes.",
    "",
    "Facts you must use:",
    "- The current weekly eFUND subscription cutoff is 16:00 UTC on every weekday.",
    "- If the question does not name an asset, assume eFUND.",
    "- The euro fund, the bond fund and the fund all mean eFUND. The phrases 'dealing cutoff', 'subscription deadline', 'fund cutoff' and 'subscription cutoff' all refer to the same supported rule. Verbs such as move, set, change, shift, propose and 'can we' all mean the same supported change.",
    "- The only supported operation is set_subscription_cutoff and the only supported asset is eFUND.",
    "- The supported weekdays are Monday to Friday only: MON, TUE, WED, THU, FRI.",
    "- timeUtc is the NEW whole-minute cutoff. Any whole minute from 00:01 through 16:59 UTC is valid, including 07:00, 09:00, 10:00, 13:00, 16:15 and 16:30.",
    "- timezone is always UTC. Convert 12-hour times to UTC (3pm becomes 15:00).",
    "- expectedTimeUtc means the PREVIOUS cutoff. Include it only when the question states the previous cutoff, for example 'from 16:00', 'instead of 16:00 UTC', 'rather than 16:00', 'one hour earlier than 16:00', or 'the current 16:00'. Copy it as HH:MM. Omit it when the question only states the new time, for example 'becomes 14:00 UTC', 'to 16:15 UTC' or 'set to 15:00 UTC'.",
    "",
    "Decision procedure, follow it in order:",
    "1. Choose unsupported only when the request changes the redemption deadline, NAV publication, fees or eligibility, names another asset, changes several weekdays or all weekdays, asks for a recurring schedule, names Saturday or Sunday, or asks for a time outside 00:01-16:59 UTC. NAV publication, redemption deadlines, fees and eligibility are fixed rules in this release, so changes to them are unsupported.",
    "2. Choose clarify when the request is plausibly about the weekly subscription cutoff but a required field is missing: no supported weekday, no new whole-minute UTC time, a non-UTC timezone such as CET, or only earlier/later without a new absolute time. Never guess a missing weekday and never reuse the current 16:00 as the answer to a vague request. Vague cutoff requests are clarified, never marked unsupported.",
    "3. Otherwise choose proposed.",
    "",
    "When proposed: include operation, asset, weekday, timeUtc, timezone and, when stated, expectedTimeUtc.",
    "When clarify: include question and missingFields.",
    "When unsupported: include the most specific reasonCode.",
    "Allowed unsupported reason codes: UNSUPPORTED_OPERATION, UNSUPPORTED_ASSET, UNSUPPORTED_WEEKDAY, OUT_OF_RANGE, MULTIPLE_CHANGES.",
    "Use no additional properties and no commentary.",
    "Study the example turns and answer the final question with one JSON object.",
  ].join("\n");
}

/** Few-shot example turns; models follow these better than inline examples. */
export function buildFewShotMessages(): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const example of FEW_SHOT_EXAMPLES) {
    messages.push({ role: "user", content: `Question: ${example.question}` });
    messages.push({ role: "assistant", content: example.answer });
  }
  return messages;
}

export function buildInitialMessages(request: LiveDraftRequest): readonly ModelMessage[] {
  return [
    { role: "system", content: buildSystemPrompt() },
    ...buildFewShotMessages(),
    { role: "user", content: buildInitialUserPrompt(request) },
  ];
}

export function buildRetryMessages(params: {
  request: LiveDraftRequest;
  previousRaw: string;
  errors: readonly string[];
}): readonly ModelMessage[] {
  return [
    { role: "system", content: buildSystemPrompt() },
    ...buildFewShotMessages(),
    { role: "user", content: buildInitialUserPrompt(params.request) },
    { role: "assistant", content: params.previousRaw.slice(0, 2000) },
    { role: "user", content: buildRetryUserPrompt(params) },
  ];
}

export function buildInitialUserPrompt(request: LiveDraftRequest): string {
  const context = {
    currentRule: {
      policyId: request.baseline.policyId,
      version: request.baseline.version,
      weekdayCutoffs: request.baseline.weekdayCutoffs,
    },
    fixture: request.fixture,
    supportedRule: request.supportedRule,
  };
  return [
    "Context (synthetic data):",
    JSON.stringify(context),
    "",
    `Question: ${request.question}`,
    "",
    "Apply the decision procedure and return one JSON object.",
  ].join("\n");
}

export function buildRetryUserPrompt(params: {
  request: LiveDraftRequest;
  previousRaw: string;
  errors: readonly string[];
}): string {
  return [
    "Your previous response was invalid.",
    "Previous response:",
    params.previousRaw.slice(0, 2000),
    "",
    "Validation errors:",
    ...params.errors.map((error) => `- ${error}`),
    "",
    "Return one corrected JSON object that follows the documented shapes exactly and uses no additional properties.",
    `Question: ${params.request.question}`,
  ].join("\n");
}

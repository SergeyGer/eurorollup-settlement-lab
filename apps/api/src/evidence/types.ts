/**
 * Evidence helpers for the API-level acceptance cases (gates A02 and A06).
 *
 * Evidence files are deterministic: sequential ids, fixture-clock timestamps
 * only, and no wall-clock values. Re-running the same case set must produce the
 * same bytes and the same business digest.
 */
import { ENGINE_VERSION } from "@eurorollup/dealing";
import { hashJson } from "@eurorollup/dealing";
import { SERVICE_VERSION } from "../config.js";

export interface EvidenceStep {
  readonly action: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly code?: string;
}

export interface EvidenceCheck {
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

export interface CaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly steps: readonly EvidenceStep[];
  readonly checks: readonly EvidenceCheck[];
  readonly pass: boolean;
}

export interface CaseSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

export interface EvidenceFile<T extends CaseResult> {
  readonly schemaVersion: "1.0.0";
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly engineVersion: string;
  readonly serviceVersion: string;
  readonly generatedBy: string;
  readonly cases: readonly T[];
  readonly summary: CaseSummary;
  readonly businessDigest: string;
}

export function summarize(cases: readonly CaseResult[]): CaseSummary {
  const passed = cases.filter((item) => item.pass).length;
  return { total: cases.length, passed, failed: cases.length - passed };
}

export function buildEvidenceFile<T extends CaseResult>(params: {
  fixtureId: string;
  fixtureVersion: string;
  generatedBy: string;
  cases: readonly T[];
}): EvidenceFile<T> {
  return {
    schemaVersion: "1.0.0",
    fixtureId: params.fixtureId,
    fixtureVersion: params.fixtureVersion,
    engineVersion: ENGINE_VERSION,
    serviceVersion: SERVICE_VERSION,
    generatedBy: params.generatedBy,
    cases: params.cases,
    summary: summarize(params.cases),
    businessDigest: hashJson(params.cases),
  };
}

function render(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value) ?? "undefined";
}

export class CaseRecorder {
  private readonly caseId: string;
  private readonly title: string;
  private readonly steps: EvidenceStep[] = [];
  private readonly checks: EvidenceCheck[] = [];

  constructor(caseId: string, title: string) {
    this.caseId = caseId;
    this.title = title;
  }

  http<T extends { status: number; body: unknown }>(
    action: string,
    method: string,
    url: string,
    response: T,
  ): T {
    const errorCode =
      typeof response.body === "object" && response.body !== null
        ? (response.body as { error?: { code?: string } }).error?.code
        : undefined;
    this.steps.push({
      action,
      method,
      url,
      status: response.status,
      ...(errorCode === undefined ? {} : { code: errorCode }),
    });
    return response;
  }

  check(label: string, actual: unknown, expected: unknown): void {
    const actualText = render(actual);
    const expectedText = render(expected);
    this.checks.push({
      label,
      expected: expectedText,
      actual: actualText,
      pass: actualText === expectedText,
    });
  }

  finish(): CaseResult {
    return {
      caseId: this.caseId,
      title: this.title,
      steps: [...this.steps],
      checks: [...this.checks],
      pass: this.checks.length > 0 && this.checks.every((check) => check.pass),
    };
  }
}

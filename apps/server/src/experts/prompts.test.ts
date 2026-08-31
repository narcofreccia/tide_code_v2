import { describe, expect, it } from "vitest";
import type { ExpertsFinding, ExpertsMessage, ExpertState } from "@tide/contracts";
import { colleagueList, delegatePrompt, discussionPrompt, explorationPrompt, formatFindings, messageDeliveryPrompt, synthesisPrompt } from "./prompts.ts";

const pat: ExpertState = { key: "perf", name: "Pat", role: "performance", provider: "claude", status: "working" };
const ana: ExpertState = { key: "api", name: "Ana", role: "API design", provider: "codex", status: "working" };
const session = { topic: "how to cache", experts: [pat, ana] };

const finding = (author: string, text: string): ExpertsFinding => ({ id: `f-${author}`, sessionId: "s", author, text, createdAt: 1 });
const message = (from: string, to: string, text: string): ExpertsMessage => ({ id: `m-${from}`, sessionId: "s", from, to, text, createdAt: 1 });

describe("experts prompts", () => {
  it("names the expert, the topic and the panel in the exploration prompt", () => {
    const prompt = explorationPrompt(session, pat);
    expect(prompt).toContain("You are Pat, performance, part of a panel of experts examining: how to cache");
    expect(prompt).toContain("Ana (API design)");
    expect(prompt).not.toContain("Pat (performance)");
    expect(prompt).toContain("tide_experts_post_finding");
    expect(prompt).toContain("tide_experts_send_message");
    expect(prompt).toContain("tide_experts_check_messages");
    expect(prompt).toContain("Do not edit files.");
  });

  it("appends the persona when one is given", () => {
    expect(explorationPrompt(session, { ...pat, persona: "You care about p99 latency." })).toContain("You care about p99 latency.");
  });

  it("carries every finding into the discussion prompt", () => {
    const prompt = discussionPrompt(session, ana, [finding("perf", "n+1 in loader"), finding("api", "leaky types")]);
    expect(prompt).toContain("Here are all findings so far");
    expect(prompt).toContain("[perf] n+1 in loader");
    expect(prompt).toContain("[api] leaky types");
    expect(prompt).toContain("Challenge, agree, refine");
    expect(prompt).toContain("Do not edit files.");
  });

  it("asks the lead for a decision document and the synthesize tool", () => {
    const prompt = synthesisPrompt(session, [finding("perf", "n+1 in loader")], [message("api", "perf", "disagree")]);
    expect(prompt).toContain("Synthesize the panel's findings");
    expect(prompt).toContain("recommended plan");
    expect(prompt).toContain("tide_experts_synthesize");
    expect(prompt).toContain("Do not implement anything");
    expect(prompt).toContain("api -> perf: disagree");
  });

  it("formats empty boards without pretending there is content", () => {
    expect(formatFindings([])).toBe("(no findings posted yet)");
    expect(colleagueList({ experts: [pat] }, "perf")).toBe("none");
  });

  it("labels delegated work and delivered messages", () => {
    expect(delegatePrompt("run the benchmark", "Pat (performance)")).toContain("delegated this task by another Tide thread");
    expect(delegatePrompt("run the benchmark", "Pat (performance)")).toContain("run the benchmark");
    expect(messageDeliveryPrompt("api", "look at the types")).toBe("Message from api: look at the types");
  });
});

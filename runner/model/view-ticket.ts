type V = Record<string, any>;
export const title = "One ticket under the thin runner";
export const state = (v: V): string => {
  if (v.done) return "Done";
  if (v.lead === "live") return "Lead working";
  if (v.half) return "Ask half written";
  if (v.asked) return "Waiting on Alex";
  if (v.event) return "Event since the last start";
  return "Lead stopped, nothing to wait for";
};
const labels: Record<string, string> = {
  LeadAsks: "the lead assigns Alex, asks and exits",
  LeadUnassigns: "the lead acts on Alex's answer and unassigns him",
  LeadCloses: "the lead merges its last PR or posts its report",
  LeadJustExits: "the lead exits with nothing handed in",
  StartsLead: "the runner starts the lead",
  AskStarts: "the runner makes the ask's first write",
  AskEnds: "the runner makes the ask's second write",
  AskFails: "the ask's second write fails",
  SomeoneActs: "someone comments or changes the ticket",
};
export const step = (action: string) => {
  const base = action.replace(/\(.*$/, "");
  return base === "Finished" ? null : (labels[base] ?? base);
};
export const group = (v: V) => {
  const s = state(v);
  if (s === "Done") return "done";
  if (/Alex|Ask|nothing|Event/.test(s)) return "alex";
  return "lead";
};
export const colors = { lead: "blue", alex: "purple", done: "teal" };

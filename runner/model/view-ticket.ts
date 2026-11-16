type V = Record<string, any>;
export const title = "One ticket under the thin runner";
export const state = (v: V): string => {
  if (v.done) return "Done";
  if (v.lead === "live") return "Lead working";
  if (v.dec) return v.linked ? "Waiting on Alex" : "Decision filed, not linked";
  if (v.event) return "Event since the last start";
  return "Lead stopped, nothing to wait for";
};
const labels: Record<string, string> = {
  LeadAsks: "the lead files a Decision issue and exits",
  LeadCloses: "the lead merges its last PR or posts its report",
  LeadJustExits: "the lead exits with nothing handed in",
  StartsLead: "the runner starts the lead",
  FilesDecision: "the runner files a Decision issue",
  LinksDecision: "the runner links the Decision issue",
  AlexClosesDecision: "Alex answers or cancels",
  SomeoneActs: "someone comments or changes the ticket",
};
export const step = (action: string) => {
  const base = action.replace(/\(.*$/, "");
  return base === "Finished" ? null : (labels[base] ?? base);
};
export const group = (v: V) => {
  const s = state(v);
  if (s === "Done") return "done";
  if (/Alex|Decision|nothing|Event/.test(s)) return "alex";
  return "lead";
};
export const colors = { lead: "blue", alex: "purple", done: "teal" };

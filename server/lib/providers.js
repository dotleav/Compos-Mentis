diff --git a/server/lib/providers.js b/server/lib/providers.js
index 81cf3c8..08a7e15 100644
--- a/server/lib/providers.js
+++ b/server/lib/providers.js
@@ -227,10 +227,27 @@ const PROVIDERS = [
 // something specific to this app. Detect them by model id and compensate:
 const REASONING_MODEL_PATTERN = /gpt-oss|nemotron/i;
 
+// Separate group: models that ALSO think by default and count thinking
+// tokens against max_tokens, but where this app never wants any hidden
+// reasoning at all (every call here is a short roleplay/tool-call reply,
+// never a task worth burning a thinking budget on). Confirmed broken
+// symptom without this: gemini-2.5-flash silently ate ~95% of a 120-token
+// reply budget on thinking and returned 1-3 word fragments with
+// finish_reason "length" (root cause of the truncated/"saya"-only replies
+// reported against this app). deepseek-v4-flash defaults to reasoning
+// effort "high" and is equally exposed — not yet observed here only
+// because it sits lower in the fallback order, behind providers that
+// currently succeed first.
+const ZERO_REASONING_MODEL_PATTERN = /gemini-(2\.5|3)|deepseek/i;
+
 function isReasoningModel(modelId) {
   return REASONING_MODEL_PATTERN.test(modelId || "");
 }
 
+function isZeroReasoningModel(modelId) {
+  return ZERO_REASONING_MODEL_PATTERN.test(modelId || "");
+}
+
 async function callProvider(provider, { messages, tools, temperature, max_tokens }) {
   const body = { model: provider.model, messages, ...(provider.extraBody || {}) };
   if (tools) body.tools = tools;
@@ -245,7 +262,19 @@ async function callProvider(provider, { messages, tools, temperature, max_tokens
   // large ceiling.
   body.max_tokens = max_tokens ?? 150;
 
-  if (isReasoningModel(provider.model)) {
+  if (isZeroReasoningModel(provider.model)) {
+    // Gemini 2.5/3 Flash and DeepSeek V4 both think by default and both
+    // count thinking tokens against max_tokens. Unlike the gpt-oss/nemotron
+    // case below, this app has no call site that benefits from ANY hidden
+    // reasoning (short roleplay lines, short tool-call replies), so the
+    // correct fix is to turn thinking off outright rather than budget
+    // around it — cheaper and faster, and it's what actually restores the
+    // full max_tokens to the visible reply. Verified against the live
+    // Gemini OpenAI-compat endpoint: same prompt went from
+    // finish_reason:"length" / ~3 visible tokens to finish_reason:"stop"
+    // with the full reply present once reasoning_effort:"none" was added.
+    if (body.reasoning_effort === undefined) body.reasoning_effort = "none";
+  } else if (isReasoningModel(provider.model)) {
     // 1) Ask for the smallest amount of hidden reasoning the model
     //    supports. Documented param name for gpt-oss (Groq, Cerebras) and
     //    honored by most OpenAI-compatible reasoning-model hosts (HF

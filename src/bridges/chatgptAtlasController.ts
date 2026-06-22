#!/usr/bin/env node
import { spawnSync } from "node:child_process";

interface DirectiveAck {
  runId: string;
  nonce: string;
  responseField: string;
}

interface AtlasControllerRequest {
  directiveAck?: DirectiveAck;
  model?: string;
  modelSelection?: {
    required?: boolean;
    acceptableLabels?: unknown[];
  };
  prompt?: string;
  requiredDataKey?: string;
}

const defaultProLabels = [
  "Pro",
  "ChatGPT Pro",
  "Extended Pro",
  "GPT-5.5 Pro",
  "GPT-5.5 Extended Pro"
];

const readStdin = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });

const parseRequest = (requestText: string): AtlasControllerRequest =>
  requestText.trim() ? JSON.parse(requestText) as AtlasControllerRequest : {};

const stringLabels = (labels: unknown[] | undefined): string[] => {
  const values = labels?.filter((label): label is string => typeof label === "string" && Boolean(label.trim())) ?? [];
  return values.length > 0 ? values : defaultProLabels;
};

const appleScript = `
on elementText(theElement)
  set fragments to {}
  try
    set elementName to name of theElement
    if elementName is not missing value and elementName is not "" then set end of fragments to elementName as text
  end try
  try
    set elementValue to value of theElement
    if elementValue is not missing value and elementValue is not "" then set end of fragments to elementValue as text
  end try
  try
    set elementDescription to description of theElement
    if elementDescription is not missing value and elementDescription is not "" then set end of fragments to elementDescription as text
  end try
  return fragments as text
end elementText

on matchesAnyLabel(valueText, labelText)
  set labels to paragraphs of labelText
  ignoring case
    repeat with oneLabel in labels
      set labelValue to oneLabel as text
      if labelValue is not "" and valueText contains labelValue then return true
    end repeat
  end ignoring
  return false
end matchesAnyLabel

on looksLikeModelSelector(valueText, labelText)
  if my matchesAnyLabel(valueText, labelText) then return true
  ignoring case
    if valueText contains "ChatGPT" then return true
    if valueText contains "Auto" then return true
    if valueText contains "model" then return true
  end ignoring
  return false
end looksLikeModelSelector

on findModelSelector(theWindow, labelText)
  set selectorCandidate to missing value
  repeat with buttonRef in buttons of theWindow
    set buttonText to my elementText(buttonRef)
    if my matchesAnyLabel(buttonText, labelText) then return buttonRef
    if selectorCandidate is missing value and my looksLikeModelSelector(buttonText, labelText) then set selectorCandidate to buttonRef
  end repeat
  return selectorCandidate
end findModelSelector

on clickUiElement(theElement)
  try
    tell application "System Events" to click theElement
    return true
  end try
  try
    tell application "System Events" to click (parent of theElement)
    return true
  end try
  return false
end clickUiElement

on clickMatchingModelOption(labelText)
  tell application "System Events"
    tell process "ChatGPT Atlas"
      repeat with windowRef in windows
        try
          set allElements to entire contents of windowRef
          repeat with labelValue in paragraphs of labelText
            if (labelValue as text) is not "" then
              repeat with elementRef in allElements
                set candidateText to my elementText(elementRef)
                ignoring case
                  if candidateText contains (labelValue as text) then
                    if my clickUiElement(elementRef) then return candidateText
                  end if
                end ignoring
              end repeat
            end if
          end repeat
        end try
      end repeat
    end tell
  end tell
  error "__MODEL_OPTION_NOT_FOUND__"
end clickMatchingModelOption

on restoreClipboard(previousClipboard)
  try
    set the clipboard to previousClipboard
  end try
end restoreClipboard

on run argv
  set promptText to item 1 of argv
  set labelText to item 2 of argv
  set modelRequired to item 3 of argv
  set observedModel to ""
  set verifiedModel to false

  tell application "ChatGPT Atlas"
    activate
  end tell
  delay 0.7

  tell application "System Events"
    tell process "ChatGPT Atlas"
      set frontmost to true
      if not (exists window 1) then error "__TARGET_WINDOW_NOT_FOUND__"
      set targetWindow to window 1
      set selectorRef to my findModelSelector(targetWindow, labelText)
      if selectorRef is missing value then error "__MODEL_SELECTOR_NOT_FOUND__"

      set observedModel to my elementText(selectorRef)
      if modelRequired is "false" then
        set verifiedModel to true
      else if my matchesAnyLabel(observedModel, labelText) then
        set verifiedModel to true
      else
        click selectorRef
        delay 0.8
        set selectedText to my clickMatchingModelOption(labelText)
        delay 1.0
        set selectorAfter to my findModelSelector(targetWindow, labelText)
        if selectorAfter is not missing value then set observedModel to my elementText(selectorAfter)
        if my matchesAnyLabel(observedModel, labelText) then
          set verifiedModel to true
        else if my matchesAnyLabel(selectedText, labelText) then
          set observedModel to selectedText
          set verifiedModel to true
        end if
      end if

      if not verifiedModel then error "__MODEL_NOT_VERIFIED__:" & observedModel

      set previousClipboard to the clipboard
      set the clipboard to promptText
      keystroke "v" using {command down}
      delay 0.1
      key code 36
      delay 0.2
      my restoreClipboard(previousClipboard)
    end tell
  end tell

  return "__MODEL_VERIFIED__:" & observedModel
end run
`;

const request = parseRequest(await readStdin());
const ack = request.directiveAck;
const requestedModel = typeof request.model === "string" ? request.model : "chatgpt-pro";
const requiredDataKey = typeof request.requiredDataKey === "string" ? request.requiredDataKey : "researchResult";
const promptText = typeof request.prompt === "string" && request.prompt.trim() ? request.prompt : "hi";
const acceptableLabels = stringLabels(request.modelSelection?.acceptableLabels);
const modelRequired = request.modelSelection?.required !== false && requestedModel !== "configured";

const result = spawnSync(
  "/usr/bin/osascript",
  [
    "-e",
    appleScript,
    promptText,
    acceptableLabels.join("\n"),
    modelRequired ? "true" : "false"
  ],
  {
    encoding: "utf8",
    timeout: 20_000
  }
);

const output = `${result.stdout || ""}${result.stderr || ""}`;
const verified = result.status === 0 && output.includes("__MODEL_VERIFIED__:");
const observedModel = verified
  ? output.split("__MODEL_VERIFIED__:").at(-1)?.trim()
  : output.match(/__MODEL_NOT_VERIFIED__:(.*)/)?.[1]?.trim() ??
    output.match(/__MODEL_SELECTOR_NOT_FOUND__|__MODEL_OPTION_NOT_FOUND__|__TARGET_WINDOW_NOT_FOUND__/)?.[0];
const summary = verified
  ? `Delivered prompt to ChatGPT Atlas after verifying ${observedModel || requestedModel}.`
  : `Did not deliver prompt to ChatGPT Atlas because the requested model was not verified: ${output.trim() || "osascript failed"}`;

const dataPayload = {
  summary,
  ...(ack
    ? {
        [ack.responseField]: {
          runId: ack.runId,
          nonce: ack.nonce,
          responseField: ack.responseField
        }
      }
    : {})
};

const response = {
  status: verified ? "ok" : "failed",
  summary,
  data: {
    [requiredDataKey]: dataPayload
  }
};

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: "thehood_chatgpt_atlas_computer_use_result",
  model: requestedModel,
  modelVerified: verified,
  ...(observedModel ? { observedModel } : {}),
  response
})}\n`);

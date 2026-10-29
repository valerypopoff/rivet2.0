import {
  type ArrayDataValue,
  type NodeId,
  type StringDataValue,
  type LatestDebuggerPrompt,
} from '@valerypopoff/rivet2-core';

type UserInputSubmitHandler = (
  nodeId: NodeId,
  answers: ArrayDataValue<StringDataValue>,
  prompt?: LatestDebuggerPrompt,
) => void;

let submitHandler: UserInputSubmitHandler = () => {};

export function setUserInputSubmitHandler(handler: UserInputSubmitHandler): void {
  submitHandler = handler;
}

export function clearUserInputSubmitHandler(): void {
  submitHandler = () => {};
}

export function submitUserInputAnswers(
  nodeId: NodeId,
  answers: ArrayDataValue<StringDataValue>,
  prompt?: LatestDebuggerPrompt,
): void {
  submitHandler(nodeId, answers, prompt);
}

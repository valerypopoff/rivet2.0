# Prompt Designer

The Prompt Designer gives you a UI to tune an inline LLM Chat node and make one-off requests while you are designing a prompt.

![Prompt Designer](./assets/prompt-designer.png)

It is opened from a chat node's flask icon. When the Prompt Designer is open, Rivet shows a Prompt Designer tab in the top bar; when it is closed, that tab is hidden.

When you click the flask icon, the node's input messages, output, and compatible generation settings are copied into the Prompt Designer automatically.

## Messages

The left side of the Prompt Designer contains the list of messages that will be sent to the model. You can add, remove, and edit messages here.

## Response

The middle of the Prompt Designer contains the model response.

## Parameters

The right side of the Prompt Designer contains tweakable model parameters, such as temperature and max tokens.

For repeatable testing, open **Evaluations** from the Prompt Designer. Evaluations owns datasets, complete-graph runs, assertions, evaluator graphs, trial counts, costs, baselines, and retained results. It deliberately does not turn a one-off prompt response into expected truth: choose the expected fields and checks explicitly.

Once you have tweaked your prompt and settings, use **Run** at the bottom left for a one-off preview. For repeatable checks and comparisons, use **Open in Evaluations**.

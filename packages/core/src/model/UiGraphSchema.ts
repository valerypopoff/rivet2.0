import { z } from 'zod';
import type { GraphId } from './NodeGraph.js';
import {
  UI_GRAPH_GAP_SIZES,
  UI_GRAPH_OUTPUT_RENDER_MODES,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  type UiGraphId,
} from './UiGraph.js';

type LegacyUiGraphComponent = UiGraphComponent extends infer TComponent
  ? TComponent extends { id: UiComponentId }
    ? Omit<TComponent, 'id'> & { id?: UiComponentId }
    : never
  : never;

const requiredString = z.string({ error: 'must be a string' });
const optionalString = z.string({ error: 'must be a string when provided' }).optional();
const componentId = z
  .custom<UiComponentId>((value) => typeof value === 'string', { error: 'must be a string' })
  .optional();
const uiGraphId = z
  .custom<UiGraphId>((value) => typeof value === 'string', { error: 'must be a string' })
  .refine((value) => value.trim().length > 0, { error: 'must be a non-empty string' });
const graphId = z
  .custom<GraphId>((value) => typeof value === 'string', { error: 'must be a string when provided' })
  .optional();
const objectOptions = { error: 'must be an object' } as const;

const inputBindingSchema = z.object({ inputKey: requiredString, stateKey: requiredString }, objectOptions);
const outputBindingSchema = z.object({ outputKey: optionalString, stateKey: requiredString }, objectOptions);
const stateValueBindingSchema = z.object({ key: requiredString, type: z.literal('state') }, objectOptions);
const literalValueBindingSchema = z
  .object({ type: z.literal('literal'), value: z.unknown() }, objectOptions)
  .superRefine((binding, context) => {
    if (!Object.hasOwn(binding, 'value')) {
      context.addIssue({ code: 'custom', message: 'is required', path: ['value'] });
    }
  });
const valueBindingSchema = z.discriminatedUnion('type', [stateValueBindingSchema, literalValueBindingSchema], {
  error: 'must be "state" or "literal"',
});
const inputMappingsSchema = z.array(inputBindingSchema, { error: 'must be an array' }).optional();

const runGraphActionSchema = z.object(
  {
    type: z.literal('runGraph'),
    graphId,
    outputKey: optionalString,
    outputStateKey: optionalString,
    inputMappings: inputMappingsSchema,
    inputs: z.record(z.string(), valueBindingSchema, { error: 'must be an object' }).optional(),
    outputs: z.array(outputBindingSchema, { error: 'must be an array' }).optional(),
  },
  objectOptions,
);
const chatRunGraphActionSchema = z.object(
  {
    type: z.literal('runGraph'),
    graphId,
    userInputId: optionalString,
    historyInputId: optionalString,
    responseOutputId: optionalString,
    inputMappings: inputMappingsSchema,
  },
  objectOptions,
);

const inputComponentFields = {
  id: componentId,
  label: requiredString,
  stateKey: requiredString,
  placeholder: optionalString,
  defaultValue: optionalString,
};

export const UI_GRAPH_COMPONENT_SCHEMA = z.discriminatedUnion(
  'type',
  [
    z.object({ id: componentId, type: z.literal('text'), text: requiredString }, objectOptions),
    z.object({ id: componentId, type: z.literal('markdown'), markdown: requiredString }, objectOptions),
    z.object(
      {
        id: componentId,
        type: z.literal('gap'),
        size: z.enum(UI_GRAPH_GAP_SIZES, { error: `must be one of: ${UI_GRAPH_GAP_SIZES.join(', ')}` }),
      },
      objectOptions,
    ),
    z.object({ type: z.literal('input'), ...inputComponentFields }, objectOptions),
    z.object({ type: z.literal('textarea'), ...inputComponentFields }, objectOptions),
    z.object(
      {
        id: componentId,
        type: z.literal('dropdown'),
        label: requiredString,
        stateKey: requiredString,
        items: z.array(z.object({ label: requiredString, value: requiredString }, objectOptions), {
          error: 'must be an array',
        }),
      },
      objectOptions,
    ),
    z.object(
      { id: componentId, type: z.literal('button'), label: requiredString, action: runGraphActionSchema },
      objectOptions,
    ),
    z.object(
      { id: componentId, type: z.literal('chat'), placeholder: optionalString, action: chatRunGraphActionSchema },
      objectOptions,
    ),
    z.object(
      {
        id: componentId,
        type: z.literal('output'),
        label: optionalString,
        stateKey: requiredString,
        renderAs: z
          .enum(UI_GRAPH_OUTPUT_RENDER_MODES, {
            error: `must be one of: ${UI_GRAPH_OUTPUT_RENDER_MODES.join(', ')}`,
          })
          .optional(),
      },
      objectOptions,
    ),
  ],
  { error: 'must have a supported string type' },
);

export const UI_GRAPH_ENVELOPE_SCHEMA = z.object(
  {
    id: uiGraphId,
    name: requiredString,
    description: optionalString,
    components: z.array(z.unknown(), { error: 'must be an array' }),
  },
  objectOptions,
);

type UiGraphEnvelope = Omit<UiGraph, 'components'> & { components: unknown[] };
type IsExactly<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type Assert<Condition extends true> = Condition;

// Adding a persisted component or envelope field must update the runtime schema in the same change.
export type _UiGraphComponentSchemaTypeCheck = Assert<
  IsExactly<z.output<typeof UI_GRAPH_COMPONENT_SCHEMA>, LegacyUiGraphComponent>
>;
export type _UiGraphEnvelopeSchemaTypeCheck = Assert<
  IsExactly<z.output<typeof UI_GRAPH_ENVELOPE_SCHEMA>, UiGraphEnvelope>
>;

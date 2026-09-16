import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import { type NodeUIData } from '../NodeImpl.js';
import { type ChartNode, type NodeId } from '../NodeBase.js';
import { MatchCaseNodeBase, type MatchCaseRoutingData } from './MatchCaseNodeBase.js';

export type MatchNodeData = MatchCaseRoutingData;
export type MatchNode = ChartNode<'match', MatchNodeData>;

/** Display-only label; the persisted `match` type remains available for existing graphs. */
export const regexMatchLegacyDisplayName = 'Regex Match (legacy)';

/** The persisted `match` type stays regex-only for backwards compatibility. */
export class MatchNodeImpl extends MatchCaseNodeBase<MatchNode> {
  protected readonly caseEditorLabel = 'Cases (regular expressions)';
  protected readonly caseEditorPlaceholder = 'Case (regular expression)';

  static create(): MatchNode {
    return {
      type: 'match',
      title: regexMatchLegacyDisplayName,
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        cases: ['YES', 'NO'],
        casePortIds: [nanoid(), nanoid()],
        valueInputMode: 'shared',
      },
    };
  }

  protected matchesCase(input: string, caseValue: string): boolean {
    return new RegExp(caseValue).test(input);
  }

  protected describeCaseMatch(caseValue: string): string {
    return `/${caseValue}/ matches the Test value`;
  }

  protected describeNoCaseMatches(): string {
    return 'no regular expression matches the Test value';
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Legacy regex-only routing node. Existing graphs keep their current behavior.

        For new graphs, use Match case. It supports exact plain-text cases by default and optional regular-expression matching.
      `,
      infoBoxTitle: `${regexMatchLegacyDisplayName} Node`,
      contextMenuTitle: regexMatchLegacyDisplayName,
      group: ['Logic'],
    };
  }
}

export const matchNode = nodeDefinition(MatchNodeImpl, regexMatchLegacyDisplayName);

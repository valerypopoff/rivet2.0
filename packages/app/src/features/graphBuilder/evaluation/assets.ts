import developmentFixturesJson from './fixtures/development-fixtures.v1.json';
import evaluationPolicyJson from './fixtures/evaluation-policy.v1.json';
import hiddenHoldoutContractJson from './fixtures/hidden-holdout.contract.v1.json';
import {
  parseGraphBuilderDevelopmentFixtureSet,
  parseGraphBuilderEvaluationPolicy,
  parseGraphBuilderHiddenHoldoutContract,
} from './contracts.js';

/**
 * Parsed, deeply frozen public development assets. Importing these values does
 * not load or imply access to the separately protected hidden holdout.
 */
export const checkedGraphBuilderDevelopmentFixtures = parseGraphBuilderDevelopmentFixtureSet(developmentFixturesJson);

export const checkedGraphBuilderEvaluationPolicy = parseGraphBuilderEvaluationPolicy(evaluationPolicyJson);

/**
 * This is only the public ownership/version contract. The protected inputs and
 * expectations are intentionally not represented in this repository.
 */
export const checkedGraphBuilderHiddenHoldoutContract =
  parseGraphBuilderHiddenHoldoutContract(hiddenHoldoutContractJson);

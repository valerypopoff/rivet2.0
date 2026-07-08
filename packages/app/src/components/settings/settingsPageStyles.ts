import { css } from '@emotion/react';

export const fields = css`
  --settings-field-gap: calc(20px * var(--ui-font-scale));
  --settings-section-gap: calc(24px * var(--ui-font-scale));
  --settings-auto-configuration-gap: calc(16px * var(--ui-font-scale));

  display: flex;
  flex-direction: column;
  gap: var(--settings-field-gap);

  .auto-configurations {
    display: flex;
    flex-direction: column;
    gap: var(--settings-auto-configuration-gap);
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: calc(14px * var(--ui-font-scale));
  }

  .settings-section + .settings-section {
    margin-top: var(--settings-section-gap);
  }

  .settings-section-heading {
    margin: 0;
    color: var(--grey-lightest);
    font-size: var(--ui-font-size-xl);
    font-weight: 700;
    line-height: 1.25;
  }

  .settings-section-fields {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .settings-section-fields > * {
    margin-top: 0 !important;
    margin-bottom: var(--settings-field-gap);
  }

  .settings-section-fields > :last-child {
    margin-bottom: 0;
  }

  .settings-toggle-field {
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
  }

  .settings-range-field {
    --ds-background-neutral: var(--settings-range-track-bg);
    --ds-background-neutral-hovered: var(--settings-range-track-bg-hover);
    --ds-background-neutral-bold: var(--settings-range-fill-bg);
    --ds-background-neutral-bold-hovered: var(--settings-range-fill-bg-hover);
    --ds-background-neutral-bold-pressed: var(--settings-range-fill-bg-pressed);
  }
`;

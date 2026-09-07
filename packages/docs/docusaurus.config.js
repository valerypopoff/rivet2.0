// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;
const useDevelopmentSearchIndex = process.env.RIVET_DOCS_DEV_SEARCH_INDEX === '1';

/** @satisfies {import('@easyops-cn/docusaurus-search-local').PluginOptions} */
const localSearchOptions = {
  docsRouteBasePath: '/',
  language: ['en'],
  // Development serves a primed, disposable `search-index.json` from the
  // live-server static directory. Production retains content-hashed filenames
  // so GitHub Pages can cache each immutable index safely.
  hashed: useDevelopmentSearchIndex ? false : 'filename',
  indexDocs: true,
  indexBlog: false,
  indexPages: true,
  // Programming documentation must be able to find meaningful short words
  // such as `if`, `for`, and `map`.
  removeDefaultStopWordFilter: ['en'],
  highlightSearchTermsOnTargetPage: true,
  searchResultLimits: 10,
  searchResultContextMaxLength: 90,
  explicitSearchResultPath: true,
  searchBarShortcut: true,
  searchBarShortcutKeymap: 'mod+k',
  searchBarPosition: 'right',
  fuzzyMatchingDistance: 1,
};

/** @type {import('@docusaurus/types').PluginConfig} */
const localSearchTheme = [require.resolve('@easyops-cn/docusaurus-search-local'), localSearchOptions];

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Rivet 2',
  tagline: 'Visual AI programming environment and runtime packages',
  favicon: 'img/favicon.png',

  url: 'https://valerypopoff.github.io',
  baseUrl: '/rivet2.0/',

  organizationName: 'valerypopoff',
  projectName: 'rivet2.0',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  trailingSlash: false,

  // Development serves the prebuilt Rivet promo from the same Docusaurus
  // origin. Production builds that entry separately after Docusaurus finishes.
  // The local-search client only enables its worker in a production bundle.
  // `yarn docs dev` therefore runs Docusaurus Start in that mode while still
  // serving this development-only static root and retaining live reload.
  staticDirectories: useDevelopmentSearchIndex ? ['static', '.promo-dev'] : ['static'],

  customFields: {
    promoDemoUrl: process.env.RIVET_PROMO_DEMO_URL || null,
  },

  plugins: [require.resolve('docusaurus-plugin-image-zoom')],

  // Search is deliberately local: the GitHub Pages deployment has no search
  // service or crawler credentials, and the complete index remains available
  // after the first static download. `docsRouteBasePath` must match the docs
  // plugin because this site serves documentation from the root route.
  themes: [localSearchTheme],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/valerypopoff/rivet2.0/tree/main/packages/docs',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/social-card-v2.png',
      colorMode: {
        defaultMode: 'dark',
      },
      navbar: {
        title: 'Rivet 2',
        logo: {
          alt: 'Rivet Logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'doc',
            docId: 'introduction',
            position: 'left',
            label: 'User Guide',
          },
          {
            type: 'doc',
            docId: 'tutorial',
            position: 'left',
            label: 'Tutorial',
          },
          {
            type: 'doc',
            docId: 'api-reference',
            position: 'left',
            label: 'API Reference',
          },
          {
            type: 'doc',
            docId: 'node-reference',
            position: 'left',
            label: 'Node Reference',
          },
          {
            type: 'doc',
            docId: 'cli',
            position: 'left',
            label: 'CLI',
          },
          {
            to: '/download',
            label: 'Download',
            position: 'right',
          },
          {
            href: 'https://github.com/valerypopoff/rivet2.0',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {
                label: 'Getting Started',
                to: '/getting-started/installation',
              },
              {
                label: 'User Guide',
                to: '/user-guide',
              },
              {
                label: 'API Reference',
                to: '/api-reference',
              },
            ],
          },
          {
            title: 'More',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/valerypopoff/rivet2.0',
              },
            ],
          },
        ],
        copyright: `Copyright (c) ${new Date().getFullYear()} Val P. Built with Docusaurus.`,
      },
      prism: {
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
};

module.exports = config;

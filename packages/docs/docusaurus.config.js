// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const lightCodeTheme = require('prism-react-renderer').themes.github;
const darkCodeTheme = require('prism-react-renderer').themes.dracula;

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
  staticDirectories: process.env.NODE_ENV === 'production' ? ['static'] : ['static', '.promo-dev'],

  customFields: {
    promoDemoUrl: process.env.RIVET_PROMO_DEMO_URL || null,
  },

  plugins: [require.resolve('docusaurus-plugin-image-zoom')],

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

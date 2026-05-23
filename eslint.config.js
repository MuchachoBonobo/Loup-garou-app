// eslint.config.js — config plate ESLint 9 minimale.
// Rules très conservatrices : surtout informationnelles (warn), pour faciliter
// l'adoption sans bloquer le build sur des cosmétiques. Lance `npm run lint`.

module.exports = [
  {
    // Fichiers Node côté serveur
    files: ["*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        // Node globals essentiels
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "args": "none", "varsIgnorePattern": "^_" }],
      "no-undef": "error",
      "eqeqeq": ["warn", "smart"],
    }
  },
  {
    // Fichiers front (HTML inline + JS dans public/)
    files: ["public/**/*.js", "public/**/*.html"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        location: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        fetch: "readonly",
        Audio: "readonly",
        Event: "readonly",
        io: "readonly",      // socket.io.client
        speechSynthesis: "readonly",
        SpeechSynthesisUtterance: "readonly",
      }
    },
    rules: {
      "no-unused-vars": "off",   // beaucoup de helpers utilisés inline dans HTML, faux positifs
      "no-undef": "off",          // pareil — globals partagés entre les <script> du HTML
      "eqeqeq": ["warn", "smart"],
    }
  },
  {
    ignores: ["node_modules/**", "snapshots/**", "logs/**", "public/sounds/**"]
  }
];

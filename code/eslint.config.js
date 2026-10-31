// eslint.config.js — configuration ESLint 9 minimale (`npm run lint`).
// Règles prudentes, surtout informatives (avertissements). Les pages HTML ne sont pas
// analysées : ESLint ne lit pas le JavaScript écrit dans une page.

module.exports = [
  {
    // Fichiers Node côté serveur
    files: ["*.js", "tests/**/*.js", "outils/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        // Globales de Node utilisées par le serveur
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
    // Fichiers JS du front (public/js)
    files: ["public/**/*.js"],
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
      "no-unused-vars": "off",   // fonctions appelées depuis les pages : faux positifs
      "no-undef": "off",          // pareil — globales partagées entre les <script> des pages
      "eqeqeq": ["warn", "smart"],
    }
  },
  {
    ignores: ["node_modules/**", "snapshots/**", "logs/**", "public/sounds/**"]
  }
];

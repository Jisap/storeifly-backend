import functions from "./functions/index.js";

export default {
  functions: {
    publicapi: {
      name: "StoreiFly Pubic API",
      source: "./functions/index.ts",
      dev: {
        port: 8787,
      }
    }
  }
}
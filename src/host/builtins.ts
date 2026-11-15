import { registerModule } from "./registry";

/**
 * The modules this build contains. Each one lives in `src/modules/<name>/` and only talks to the app through `./sdk`.
 * None yet; a module is added here with `registerModule(...)`, and the user switches it on in settings.
 */
export function registerBuiltins() {
  void registerModule;
}

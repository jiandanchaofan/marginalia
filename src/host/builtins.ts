import { bibleModule } from "../modules/bible";
import { registerModule } from "./registry";

/**
 * The modules this build contains. Each one lives in `src/modules/<name>/` and only talks to the app through `./sdk`.
 * The user switches them on in settings.
 */
export function registerBuiltins() {
  registerModule(bibleModule);
}

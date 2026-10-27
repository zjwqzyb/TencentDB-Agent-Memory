import type { ICodeSourceProvider } from "../types.js";
import { basicAuthMethod } from "../auth-methods/basic.js";
import { CloneUrlError } from "../clone-url.js";

/** Production company Git extension; credentials must never be sent to another origin. */
export const bjjhGitProvider: ICodeSourceProvider = {
  id: "bjjh_git",
  sitePaths: {},
  authMethod: basicAuthMethod,
  applyToCloneUrl(repoUrl, credential) {
    if (new URL(repoUrl).origin !== "https://git.bjjhltd.com") {
      throw new CloneUrlError(
        "Company Git credential is restricted to git.bjjhltd.com",
      );
    }
    return basicAuthMethod.buildCloneUrl(repoUrl, credential);
  },
};

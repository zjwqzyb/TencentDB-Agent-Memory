import { describe, expect, it } from "vitest";
import { bjjhGitProvider } from "./bjjh-git.js";
import { buildCloneUrl, stripCredentials } from "../clone-url.js";

describe("company Git credentials", () => {
  it("uses basic auth and safely encodes reserved characters", () => {
    const credential = bjjhGitProvider.authMethod.buildCredential({
      username: "dev@company",
      secret: "p:/@ss",
    });
    const result = new URL(
      buildCloneUrl(
        bjjhGitProvider,
        "https://git.bjjhltd.com/team/repo.git",
        credential,
      ),
    );
    expect(decodeURIComponent(result.username)).toBe("dev@company");
    expect(decodeURIComponent(result.password)).toBe("p:/@ss");
    expect(stripCredentials(result.toString())).toBe(
      "https://git.bjjhltd.com/team/repo.git",
    );
  });
  it.each([
    "https://other.example/repo.git",
    "http://git.bjjhltd.com/repo.git",
    "https://git.bjjhltd.com.evil.example/repo.git",
    "https://git.bjjhltd.com:8443/repo.git",
    "https://git.bjjhltd.com@evil.example/repo.git",
  ])("rejects credentials for %s", (url) => {
    expect(() =>
      buildCloneUrl(bjjhGitProvider, url, { username: "dev", secret: "test" }),
    ).toThrow();
  });
  it.each([{ username: "dev" }, { secret: "test" }])(
    "requires both credential fields",
    (form) => {
      expect(() => bjjhGitProvider.authMethod.buildCredential(form)).toThrow();
    },
  );
});

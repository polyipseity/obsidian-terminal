import process from "node:process";

export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [
    () =>
      Boolean(
        process.env.GITHUB_DEPENDABOT_CRED_TOKEN ||
        process.env.GITHUB_DEPENDABOT_JOB_TOKEN,
      ),
    (/** @type {string} */ message) =>
      message.includes("Signed-off-by: dependabot[bot]"),
  ],
};

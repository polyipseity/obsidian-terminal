export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [(message) => message.includes("Signed-off-by: dependabot[bot]")],
};

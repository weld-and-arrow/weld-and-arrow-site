#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const PRICING_URL = "https://docs.claude.com/en/docs/about-claude/pricing";

function extractPrices(page, modelName) {
  const normalized = page.replace(/\s+/g, " ");
  const tableStart = normalized.indexOf("Model pricing");
  const searchArea = tableStart === -1 ? normalized : normalized.slice(tableStart);
  const start = searchArea.indexOf(modelName);
  if (start === -1) {
    throw new Error(`Could not find pricing row for ${modelName}`);
  }

  const slice = searchArea.slice(start, start + 600);
  const prices = [...slice.matchAll(/\$(\d+(?:\.\d+)?)\s*\/\s*MTok/g)].map((match) => match[1]);
  if (prices.length < 5) {
    throw new Error(`Could not parse all pricing columns for ${modelName}`);
  }

  return {
    input: prices[0],
    output: prices[4]
  };
}

async function main() {
  const response = await fetch(PRICING_URL, {
    headers: { accept: "text/html" }
  });
  if (!response.ok) throw new Error(`Pricing fetch failed: ${response.status}`);

  const page = await response.text();
  const fable = extractPrices(page, "Claude Fable 5");
  const haiku = extractPrices(page, "Claude Haiku 4.5");

  const vars = {
    PRICE_FABLE_INPUT: fable.input,
    PRICE_FABLE_OUTPUT: fable.output,
    PRICE_HAIKU_INPUT: haiku.input,
    PRICE_HAIKU_OUTPUT: haiku.output
  };

  for (const [key, value] of Object.entries(vars)) {
    console.log(`${key}=${value}`);
  }

  if (process.argv.includes("--github-env")) {
    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) throw new Error("GITHUB_ENV is not set");
    appendFileSync(githubEnv, Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

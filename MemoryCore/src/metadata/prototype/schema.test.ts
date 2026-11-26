import { describe, expect, it } from "vitest";
import { definition, save, validateTree, type Snapshot } from "./schema.js";

const group = definition.parse({
  properties: {},
  slots: { fields: ["text"] },
  bindings: [],
  interactions: [],
  views: ["create"],
});
const text = definition.parse({
  properties: {
    label: { type: "string", required: true },
    width: { type: "number", minimum: 1 },
  },
  slots: {},
  bindings: ["value"],
  interactions: [],
  views: ["create"],
});
const contracts = (type: string, rev: number) =>
  rev === 1 ? { group, text }[type as "group" | "text"] : undefined;
const view: Snapshot = {
  format_version: 1,
  views: ["create"],
  components: [
    {
      id: "header",
      type: "group",
      contract_version: 1,
      parent_id: null,
      slot: null,
      order: 0,
      props: {},
      bindings: {},
    },
    {
      id: "name",
      type: "text",
      contract_version: 1,
      parent_id: "header",
      slot: "fields",
      order: 0,
      props: { label: "名称" },
      bindings: { value: "customer.name" },
    },
  ],
};

describe("published component contract and exact-version tree", () => {
  it("accepts an empty page and a nested field", () => {
    validateTree({ ...view, components: [] }, contracts);
    validateTree(view, contracts);
  });
  it.each([
    ["missing contract", { contract_version: 2 }],
    ["duplicate id", { id: "header" }],
    ["missing parent", { parent_id: "absent" }],
    ["wrong slot", { slot: "toolbar" }],
    ["unknown binding", { bindings: { sql: "name" } }],
    ["missing required property", { props: {} }],
    ["invalid property type", { props: { label: false } }],
    ["invalid width", { props: { label: "A", width: 0 } }],
    ["undeclared property", { props: { label: "A", secret: "x" } }],
  ] as const)("rejects %s", (_case, patch) => {
    expect(() =>
      validateTree(
        {
          ...view,
          components: [
            view.components[0],
            { ...view.components[1], ...patch },
          ] as Snapshot["components"],
        },
        contracts,
      ),
    ).toThrow();
  });
  it("rejects cycles even when both slots allow the child", () => {
    const components = ["a", "b"].map((id, i) => ({
      ...view.components[0],
      id,
      parent_id: i === 0 ? "b" : "a",
      slot: "child",
    }));
    expect(() =>
      validateTree({ ...view, components }, () => ({
        ...group,
        slots: { child: ["group"] },
      })),
    ).toThrow(/cyclic/);
  });
  it("rejects out-of-format fields and duplicate page keys", () => {
    const unit = { page_key: "page", base_version: null, snapshot: view };
    const request = {
      team_id: "team",
      asset_id: "asset",
      request_id: "one",
      pages: [unit],
    };
    expect(save.safeParse(request).success).toBe(true);
    expect(save.safeParse({ ...request, pages: [unit, unit] }).success).toBe(
      false,
    );
    expect(save.safeParse({ ...request, user_id: "other" }).success).toBe(
      false,
    );
    expect(
      save.safeParse({
        ...request,
        pages: [{ ...unit, snapshot: { ...view, new_field: 1 } }],
      }).success,
    ).toBe(false);
  });
  it("rejects incompatible defaults", () => {
    expect(
      definition.safeParse({
        ...text,
        properties: { count: { type: "number", default: "1" } },
      }).success,
    ).toBe(false);
  });
});

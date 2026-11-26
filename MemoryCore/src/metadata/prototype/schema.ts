import { z } from "zod";
import { isDeepStrictEqual } from "node:util";

const reserved = new Set(
  Object.getOwnPropertyNames(Object.prototype).concat("prototype"),
);
export const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/)
  .refine(
    (s) => s.split(".").every((part) => !reserved.has(part)),
    "Reserved identifier",
  );
export const version = z.number().int().positive();
const names = z
  .array(identifier)
  .max(512)
  .refine((xs) => new Set(xs).size === xs.length, "Duplicate identifier");
const property = z.strictObject({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().optional(),
  default: z.json().optional(),
  enum: z.array(z.json()).nonempty().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

function conforms(value: unknown, spec: z.infer<typeof property>) {
  const type = Array.isArray(value) ? "array" : typeof value;
  return (
    value !== null &&
    type === spec.type &&
    (!spec.enum || spec.enum.some((x) => isDeepStrictEqual(x, value))) &&
    (typeof value !== "number" ||
      (value >= (spec.minimum ?? -Infinity) &&
        value <= (spec.maximum ?? Infinity)))
  );
}

export const definition = z
  .strictObject({
    properties: z.record(identifier, property),
    slots: z.record(identifier, names),
    bindings: names,
    interactions: names,
    views: names,
  })
  .superRefine((def, ctx) => {
    for (const [key, spec] of Object.entries(def.properties)) {
      if (
        (spec.default !== undefined && !conforms(spec.default, spec)) ||
        spec.enum?.some((value) => !conforms(value, spec)) ||
        ((spec.minimum !== undefined || spec.maximum !== undefined) &&
          spec.type !== "number") ||
        (spec.minimum ?? -Infinity) > (spec.maximum ?? Infinity)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["properties", key],
          message: "Invalid constraint or default",
        });
      }
    }
  });

export const snapshot = z.strictObject({
  format_version: z.literal(1),
  views: names.refine((xs) => xs.length > 0, "Specify a view"),
  components: z
    .array(
      z.strictObject({
        id: identifier,
        type: identifier,
        contract_version: version,
        parent_id: identifier.nullable(),
        slot: identifier.nullable(),
        order: z.number().int().nonnegative(),
        props: z.record(identifier, z.json()),
        bindings: z.record(identifier, identifier),
      }),
    )
    .max(4096),
});
export type Snapshot = z.infer<typeof snapshot>;
export type Definition = z.infer<typeof definition>;
export const team = z.strictObject({ team_id: identifier });
export const project = team.extend({ asset_id: identifier });
export const projectCreate = team.extend({
  name: z.string().trim().min(1).max(250),
  visibility: z.enum(["team", "private", "restricted"]).default("team"),
});
export const page = project.extend({ page_key: identifier });
export const readPage = page.extend({
  version: version.optional(),
  agent_id: identifier.optional(),
});
export const readContract = project.extend({
  component_type: identifier,
  contract_version: version,
  agent_id: identifier.optional(),
});
export const publish = readContract
  .omit({ agent_id: true })
  .extend({ definition });
export const save = project.extend({
  request_id: identifier,
  pages: z
    .array(
      z.strictObject({
        page_key: identifier,
        base_version: version.nullable(),
        snapshot,
      }),
    )
    .min(1)
    .max(64)
    .refine(
      (xs) => new Set(xs.map((x) => x.page_key)).size === xs.length,
      "Duplicate page",
    ),
});
export const restore = page.extend({
  request_id: identifier,
  base_version: version,
  restore_version: version,
});

// A flat tree preserves instance identity and order independently of JSON field order.
export function validateTree(
  data: Snapshot,
  contractOf: (type: string, version: number) => Definition | undefined,
) {
  const nodes = new Map(data.components.map((node) => [node.id, node]));
  if (nodes.size !== data.components.length)
    throw new Error("Duplicate component ID");
  const positions = new Set<string>();
  const visited = new Set<string>();
  for (const node of data.components) {
    const fail = (reason: string): never => {
      throw new Error(
        node.id +
          " (" +
          node.type +
          "@" +
          node.contract_version +
          "): " +
          reason,
      );
    };
    const contract =
      contractOf(node.type, node.contract_version) ?? fail("missing contract");
    if (!contract.views.some((view) => data.views.includes(view)))
      fail("unsupported view");
    for (const key of Object.keys(node.props)) {
      if (!Object.hasOwn(contract.properties, key)) fail("unknown property " + key);
    }
    for (const [key, spec] of Object.entries(contract.properties)) {
      if (!Object.hasOwn(node.props, key)) {
        if (spec.required && spec.default === undefined)
          fail("missing property " + key);
      } else if (!conforms(node.props[key], spec))
        fail("invalid property " + key);
    }
    if (
      Object.hasOwn(node.props, "action") &&
      !contract.interactions.includes(String(node.props.action))
    )
      fail("unknown action");
    for (const key of Object.keys(node.bindings)) {
      if (!contract.bindings.includes(key)) fail("unknown binding " + key);
    }
    const position = JSON.stringify([node.parent_id, node.slot, node.order]);
    if (positions.has(position)) fail("duplicate sibling order");
    positions.add(position);
    if (node.parent_id === null) {
      if (node.slot !== null) fail("root cannot have a slot");
    } else {
      const parent = nodes.get(node.parent_id) ?? fail("missing parent");
      const allowed = contractOf(parent.type, parent.contract_version)?.slots[
        node.slot ?? ""
      ];
      if (!allowed?.includes(node.type)) fail("slot does not accept component");
    }
    const path = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor !== null && !visited.has(cursor)) {
      if (path.has(cursor)) fail("cyclic parent reference");
      path.add(cursor);
      cursor = nodes.get(cursor)?.parent_id ?? null;
    }
    for (const id of path) visited.add(id);
  }
}

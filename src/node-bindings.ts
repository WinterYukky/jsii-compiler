import * as spec from '@jsii/spec';

/**
 * Associations between the elements of the assembly being produced and the
 * (client-side) TypeScript AST nodes they were produced from, so that the
 * validator can attach its diagnostics to source locations. Replaces the
 * `ts.Node` bindings of the previous implementation; the nodes are the resolved
 * declaration nodes of the `#typescript/ast` module.
 */

const RELATED_NODES = new WeakMap<object, any>();

export function setRelatedNode<T extends object>(object: T, node: any | undefined): T {
  if (node != null) {
    RELATED_NODES.set(object, node);
  }
  return object;
}

export function getRelatedNode<T = any>(object: object): T | undefined {
  return RELATED_NODES.get(object);
}

export const getClassRelatedNode = getRelatedNode as (object: spec.ClassType) => any | undefined;
export const getClassOrInterfaceRelatedNode = getRelatedNode as (
  object: spec.ClassType | spec.InterfaceType,
) => any | undefined;
export const getEnumRelatedNode = getRelatedNode as (object: spec.EnumType) => any | undefined;
export const getInterfaceRelatedNode = getRelatedNode as (object: spec.InterfaceType) => any | undefined;
export const getMethodRelatedNode = getRelatedNode as (object: spec.Method) => any | undefined;
export const getParameterRelatedNode = getRelatedNode as (object: spec.Parameter) => any | undefined;
export const getPropertyRelatedNode = getRelatedNode as (object: spec.Property) => any | undefined;
export const getTypeRelatedNode = getRelatedNode as (object: spec.Type) => any | undefined;

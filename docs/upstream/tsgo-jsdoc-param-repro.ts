/** A greeter contract with documented method parameters. */
export interface IGreeter {
  /**
   * Greets a person.
   * @param name the name of the person to greet
   */
  greet(name: string): void;
}

/** Overrides `greet` WITH its own JSDoc (summary only, no `@param`). */
export class PoliteGreeter implements IGreeter {
  /**
   * Greets politely.
   */
  public greet(name: string): void {
    void name;
  }
}

/** Overrides `greet` with NO JSDoc at all. */
export class SilentGreeter implements IGreeter {
  public greet(name: string): void {
    void name;
  }
}

/** Constructor JSDoc with a multi-line `@param` block. */
export class Tagged {
  /**
   * Creates a tag.
   * @param key The string key for the tag.
   * @param value The string value of the tag.
   */
  constructor(key: string, value: string) {
    void key;
    void value;
  }
}

/** Inline JSDoc directly on a parameter property. */
export class KeyAlgorithm {
  constructor(
    /** The name of the algorithm. */
    public readonly name: string,
  ) {}
}

/** Single-line JSDoc `@param` on a constructor with a parameter property. */
export class Boxed {
  /** @param image The Docker image */
  constructor(public readonly image: string) {}
}

/** Base class with a documented property. */
export class WithCount {
  /** How many widgets there are. */
  public readonly count: number = 0;
}

/** Subclass ctor without JSDoc: TS5 inherits param doc from base property `count`. */
export class CountedTwice extends WithCount {
  constructor(count: number) {
    super();
    void count;
  }
}


/** Abstract base class with a documented abstract method. */
export abstract class MatcherBase {
  /**
   * Tests the value.
   * @param actual the target to match
   */
  public abstract test(actual: string): void;
}

/** Override WITH its own JSDoc (summary only, no `@param`). */
export class CaptureLike extends MatcherBase {
  /** Captures the value. */
  public test(actual: string): void {
    void actual;
  }
}

/** Override with NO JSDoc at all. */
export class PlainCapture extends MatcherBase {
  public test(actual: string): void {
    void actual;
  }
}

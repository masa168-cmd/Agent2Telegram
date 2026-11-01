import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type CapturedAgentSession = AgentSession & {
  extensionRunner: AgentSession["extensionRunner"] & {
    getUIContext(): ExtensionUIContext;
    setUIContext(ui?: ExtensionUIContext): void;
  };
};

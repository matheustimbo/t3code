/**
 * The name a machine goes by in the clients connected to it.
 *
 * Its settings come first because they are the one copy that refreshes while
 * the connection is up, so a rename lands everywhere without a reconnect. The
 * descriptor is the name the server read from the OS at startup, and the
 * catalog label is only what this client wrote down when the machine was
 * added, which can be a hostname the machine has since stopped using.
 */
export function environmentDisplayLabel(presentation: {
  readonly entry: { readonly target: { readonly label: string } };
  readonly serverConfig: {
    readonly environment?: { readonly label?: string | undefined } | undefined;
    readonly settings?: { readonly environmentLabel?: string | undefined } | undefined;
  } | null;
}): string {
  const serverConfig = presentation.serverConfig;
  return (
    serverConfig?.settings?.environmentLabel?.trim() ||
    serverConfig?.environment?.label ||
    presentation.entry.target.label
  );
}

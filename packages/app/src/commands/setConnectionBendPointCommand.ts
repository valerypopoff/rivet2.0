import { type NodeConnection } from '@valerypopoff/rivet2-core';
import { useSetAtom } from 'jotai';
import { useCommand } from './Command';
import { setConnectionBendPoint } from '../domain/graphEditing/connectionActions.js';
import { connectionsState } from '../state/graph';

export function useSetConnectionBendPointCommand() {
  const setConnections = useSetAtom(connectionsState);

  return useCommand<
    {
      connection: NodeConnection;
      bendPoint: NodeConnection['bendPoint'] | undefined;
    },
    {
      previousConnection: NodeConnection | undefined;
      nextConnection: NodeConnection | undefined;
    }
  >({
    type: 'setConnectionBendPoint',
    apply(params, _appliedData, currentState) {
      const change = setConnectionBendPoint({
        connections: currentState.connections,
        connectionToUpdate: params.connection,
        bendPoint: params.bendPoint,
      });

      if (!change) {
        return {
          previousConnection: undefined,
          nextConnection: undefined,
        };
      }

      setConnections(change.connections);

      return {
        previousConnection: change.previousConnection,
        nextConnection: change.nextConnection,
      };
    },
    undo(_data, appliedData, currentState) {
      if (!appliedData.previousConnection || !appliedData.nextConnection) {
        return;
      }

      const change = setConnectionBendPoint({
        connections: currentState.connections,
        connectionToUpdate: appliedData.nextConnection,
        bendPoint: appliedData.previousConnection.bendPoint,
      });

      if (change) {
        setConnections(change.connections);
      }
    },
  });
}

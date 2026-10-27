/** Issues retain task identity so session and memory associations stay valid. */
import { useTranslation } from 'react-i18next';
import IssueWorkbench from './IssueWorkbench';
import type { AgentOption, WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

export default function TaskWorkbench(props: {
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  activeTeamId: string | null;
  currentUser: string;
  agents: AgentOption[];
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  if (!props.activeTeamId)
    return (
      <div className="_memory-workbench-empty-card">
        <h2>{t('task.emptyTeam.title')}</h2>
        <p>{t('task.emptyTeam.desc')}</p>
      </div>
    );
  return (
    <IssueWorkbench key={props.activeTeamId} teamId={props.activeTeamId} agents={props.agents} />
  );
}

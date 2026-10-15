'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import Dropdown from '@/components/ui/Dropdown';
import PageHeader from '@/components/ui/PageHeader';
import BackButton from '@/components/ui/BackButton';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import { useTaskAnalytics } from '@/hooks/taskHooks/useTaskAnalytics';
import { STATUS_VARIANTS, styleOf, taskPriorityMeta, taskStatusMeta, type StatusVariant } from '@/constants/statusMeta';
import { BarChart3 } from 'lucide-react';

const DATE_RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

type Props = {
  lawFirmId: string;
};

export default function TaskAnalytics({ lawFirmId }: Props) {
  const [dateRange, setDateRange] = useState('30d');
  const { data, loading, error } = useTaskAnalytics(lawFirmId, dateRange);

  if (loading) return <LoadingSpinner fullPage />;

  const summary = data?.summary;
  const overduePercent = summary && summary.total > 0
    ? Math.round((summary.overdue / summary.total) * 100)
    : 0;
  const completionPercent = summary && summary.total > 0
    ? Math.round((summary.completed / summary.total) * 100)
    : 0;

  const priorityData = data?.byPriority
    ? Object.entries(data.byPriority)
        .map(([name, value]) => ({ name, value }))
        .filter(entry => entry.value > 0)
    : [];

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">

        <BackButton href={`/lawfirm/${lawFirmId}/tasks`} label="Back to Tasks" variant="link" />

        <PageHeader
          eyebrow="Analytics"
          title="Task Analytics"
          description="Track task completion rates, overdue trends, and team workload distribution."
        />

        <ErrorNotification error={error} onClose={() => {}} />

        {/* Date range filter */}
        <div className="max-w-xs">
          <Dropdown
            label="Date Range"
            value={dateRange}
            onChange={setDateRange}
            options={DATE_RANGE_OPTIONS}
          />
        </div>

        {!data ? (
          <div className="text-center py-12">
            <BarChart3 size={32} className="mx-auto text-on-surface-muted mb-3" />
            <p className="text-sm text-on-surface-secondary">No analytics data available.</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="Total Tasks" value={summary?.total ?? 0} />
              <StatCard label="Completed" value={summary?.completed ?? 0} variant={taskStatusMeta('completed').variant} />
              <StatCard label="Open" value={summary?.open ?? 0} variant={taskStatusMeta('open').variant} />
              <StatCard label="In Progress" value={summary?.inProgress ?? 0} variant={taskStatusMeta('in_progress').variant} />
              <StatCard label="Overdue" value={`${summary?.overdue ?? 0} (${overduePercent}%)`} variant="danger" />
              <StatCard
                label="Avg Completion"
                value={data.avgCompletionDays !== null ? `${data.avgCompletionDays}d` : '-'}
              />
            </div>

            {/* Charts row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Completion trend line chart */}
              {data.completionTrend.length > 0 && (
                <div className="bg-surface rounded-xl border border-outline-subtle p-5">
                  <h3 className="text-sm font-semibold text-on-surface mb-4">Task Activity Over Time</h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={data.completionTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-subtle, #e5e7eb)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: string) => {
                          const d = new Date(v + 'T00:00:00');
                          return `${d.getMonth() + 1}/${d.getDate()}`;
                        }}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        labelFormatter={(v) => new Date(String(v) + 'T00:00:00').toLocaleDateString()}
                      />
                      <Line type="monotone" dataKey="created" stroke="#6366f1" strokeWidth={2} name="Created" dot={false} />
                      <Line type="monotone" dataKey="completed" stroke="#22c55e" strokeWidth={2} name="Completed" dot={false} />
                      <Legend />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Priority breakdown pie chart */}
              {priorityData.length > 0 && (
                <div className="bg-surface rounded-xl border border-outline-subtle p-5">
                  <h3 className="text-sm font-semibold text-on-surface mb-4">Tasks by Priority</h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie
                        data={priorityData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={3}
                        dataKey="value"
                        nameKey="name"
                        label={({ name, value }) => `${name ?? ''}: ${value}`}
                      >
                        {priorityData.map((entry) => (
                          <Cell key={entry.name} fill={styleOf(taskPriorityMeta(entry.name)).hex} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Completion rate bar */}
            <div className="bg-surface rounded-xl border border-outline-subtle p-5">
              <h3 className="text-sm font-semibold text-on-surface mb-3">Completion Rate</h3>
              <div className="flex items-center gap-4">
                <div className="flex-1 h-4 rounded-full bg-surface-alt overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all duration-500"
                    style={{ width: `${completionPercent}%` }}
                  />
                </div>
                <span className="text-sm font-semibold text-on-surface">{completionPercent}%</span>
              </div>
            </div>

            {/* By assignee table */}
            {data.byAssignee.length > 0 && (
              <div className="bg-surface rounded-xl border border-outline-subtle overflow-hidden">
                <div className="px-5 py-4 border-b border-outline-subtle">
                  <h3 className="text-sm font-semibold text-on-surface">Workload by Assignee</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-surface-alt text-on-surface-secondary text-left">
                        <th className="px-5 py-2.5 font-medium">Assignee</th>
                        <th className="px-5 py-2.5 font-medium text-center">Total</th>
                        <th className="px-5 py-2.5 font-medium text-center">Completed</th>
                        <th className="px-5 py-2.5 font-medium text-center">Overdue</th>
                        <th className="px-5 py-2.5 font-medium text-center">Completion %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byAssignee.map((row) => (
                        <tr key={row.userId} className="border-t border-outline-subtle hover:bg-surface-hover transition-colors">
                          <td className="px-5 py-2.5 text-on-surface">{row.name}</td>
                          <td className="px-5 py-2.5 text-center">{row.total}</td>
                          <td className={`px-5 py-2.5 text-center ${STATUS_VARIANTS.success.text}`}>{row.completed}</td>
                          <td className={`px-5 py-2.5 text-center ${STATUS_VARIANTS.danger.text}`}>{row.overdue}</td>
                          <td className="px-5 py-2.5 text-center">
                            {row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * `variant` names the state the number describes, not a colour, so a figure here
 * is the same colour as the badge for that state elsewhere. Omit it for totals and
 * averages, which describe no state.
 */
function StatCard({ label, value, variant }: { label: string; value: string | number; variant?: StatusVariant }) {
  return (
    <div className="bg-surface rounded-xl border border-outline-subtle p-4">
      <p className="text-[11px] font-medium text-on-surface-muted uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-bold ${variant ? STATUS_VARIANTS[variant].text : 'text-on-surface'}`}>{value}</p>
    </div>
  );
}

/** Where a project's documents live inside a profile (relative, forward-slash: change-service targets). */
export const lessonsDir = (projectId: string) => `projects/${projectId}/lessons`;
export const lessonTarget = (projectId: string, lessonId: string) => `${lessonsDir(projectId)}/${lessonId}.json`;
export const projectTarget = (projectId: string) => `projects/${projectId}/project.json`;

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EffectiveConfig } from '../api/types';

/**
 * Root under which new bots get their workspace (LUCKAGENT_PROJECTS_DIR,
 * default ~/projects), for the "自动创建 <root>/<名称>" hints. Falls back to
 * the default label until the config call returns.
 */
export function useProjectsRoot(): string {
  const [root, setRoot] = useState('~/projects');
  useEffect(() => {
    let alive = true;
    api
      .get<EffectiveConfig>('/admin/api/config')
      .then((cfg) => {
        const r = cfg?.paths?.projectsRoot;
        if (alive && r) setRoot(r);
      })
      .catch(() => {
        /* keep the default label */
      });
    return () => {
      alive = false;
    };
  }, []);
  return root;
}

import { useQuery } from '@tanstack/react-query'
import { api, describeError, type Workflow, type WorkflowIn } from '../api/client'

/** The actions workflow steps can use. */
export function useCatalog(slug: string) {
  return useQuery({
    queryKey: ['workflow-actions', slug],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/api/tenants/{slug}/workflow-actions', {
        params: { path: { slug } },
      })
      if (!data) throw new Error(describeError(error, response.status))
      return data
    },
  })
}

/** The editable part of a saved workflow. */
export function toInput(w: Workflow): WorkflowIn {
  return {
    name: w.name,
    description: w.description,
    enabled: w.enabled,
    trigger: w.trigger,
    steps: w.steps,
  }
}

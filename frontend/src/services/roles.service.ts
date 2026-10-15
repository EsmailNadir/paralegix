import BaseApiService from './base.service';
import type { Role } from '@/types/role';

class RolesService extends BaseApiService {
  private endpoint(lawFirmId: string, roleId?: string): string {
    return roleId ? this.url('lawfirms', lawFirmId, 'roles', roleId) : this.url('lawfirms', lawFirmId, 'roles');
  }

  async listRoles(lawFirmId: string): Promise<Role[]> {
    const response = await this.dedupedGet<Role[] | { roles: Role[] }>(this.endpoint(lawFirmId), {
      errorMessage: 'Failed to load roles',
    });
    return Array.isArray(response) ? response : response.roles || [];
  }

  getRole(lawFirmId: string, roleId: string): Promise<Role> {
    return this.dedupedGet(this.endpoint(lawFirmId, roleId), { errorMessage: 'Failed to load role' });
  }

  async createRole(lawFirmId: string, data: { name: string; permissions: string[] }): Promise<Role> {
    const response = await this.request<{ role: Role }>(this.endpoint(lawFirmId), {
      method: 'POST', body: data, errorMessage: 'Failed to create role',
    });
    return response.role;
  }

  async updateRole(lawFirmId: string, roleId: string, data: Partial<Pick<Role, 'name' | 'permissions'>>): Promise<Role> {
    const response = await this.request<{ role: Role }>(this.endpoint(lawFirmId, roleId), {
      method: 'PUT', body: data, errorMessage: 'Failed to update role',
    });
    return response.role;
  }

  deleteRole(lawFirmId: string, roleId: string): Promise<void> {
    return this.request(this.endpoint(lawFirmId, roleId), {
      method: 'DELETE', errorMessage: 'Failed to delete role',
    });
  }
}

const rolesService = new RolesService();
export default rolesService;

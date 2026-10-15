import BaseApiService from './base.service';
import { uploadResumable } from '@/lib/files/resumableUpload';
import type { User } from '@/types';

interface LawFirmsResponse {
  lawFirmIds: string[];
}

/** One firm the signed-in user belongs to, as seen from their own account. */
export interface FirmMembership {
  lawFirmId: string;
  lawFirmName: string | null;
  roleName: string | null;
  isOwner: boolean;
  joinedAt: string | null;
}

class UserService extends BaseApiService {
  constructor() {
    super('users');
  }

  getProfile(): Promise<User> {
    return this.dedupedGet(this.url('profile'), { errorMessage: 'Failed to load profile' });
  }

  getUsersByLawFirm(lawfirmId: string): Promise<User[]> {
    return this.dedupedGet(this.url('lawfirm', lawfirmId, 'users'), { errorMessage: 'Failed to load firm users' });
  }

  async getAllUsers(): Promise<{ users: User[]; truncated: boolean; ceiling: number }> {
    const response = await this.dedupedGet<{ users?: User[]; truncated?: boolean; ceiling?: number }>(
      this.baseUrl,
      { errorMessage: 'Failed to load users' },
    );
    return { users: response.users ?? [], truncated: response.truncated ?? false, ceiling: response.ceiling ?? 0 };
  }

  getUserById(userId: string): Promise<User> {
    return this.dedupedGet(this.url(userId), { errorMessage: 'Failed to load user' });
  }

  /**
   * Upload a profile picture straight to storage.
   *
   * The file used to be POSTed to the API as multipart, which held the whole
   * picture in a container that serves many requests at once. Three steps now:
   * ask for a session, PUT the bytes to storage, tell the API where they
   * landed. The signature is unchanged, so callers do not care.
   *
   * `uploadResumable` is shared with the files uploader rather than reimplemented
   * here. It carries no API credential, which matters: the session url is
   * already the authorization, and attaching a bearer token would send the
   * user's credential to a host that never needed it.
   *
   * Finalize runs only after the PUT resolves. Reached after a failed upload it
   * would point the profile at an object that is not there and report success.
   */
  async setPhoto(file: File): Promise<{ photoUrl: string | null }> {
    const { uploadUrl, objectPath } = await this.request<{ uploadUrl: string; objectPath: string }>(
      this.url('me', 'photo', 'upload-init'),
      {
        method: 'POST',
        body: {
          contentType: file.type || 'application/octet-stream',
          fileName: file.name,
          size: file.size,
        },
        errorMessage: 'Failed to upload profile picture',
      },
    );

    await uploadResumable({
      file,
      sessionUrl: uploadUrl,
      contentType: file.type || 'application/octet-stream',
    });

    return this.request(this.url('me', 'photo', 'upload-finalize'), {
      method: 'POST',
      body: { objectPath },
      errorMessage: 'Failed to upload profile picture',
    });
  }

  deletePhoto(): Promise<void> {
    return this.request(this.url('me', 'photo'), { method: 'DELETE', errorMessage: 'Failed to remove profile picture' });
  }

  getMyLawFirms(): Promise<LawFirmsResponse> {
    return this.request(this.url('my-lawfirms'), { errorMessage: 'Failed to fetch my law firms' });
  }

  async getMyMemberships(): Promise<FirmMembership[]> {
    const body = await this.request<{ memberships?: FirmMembership[] }>(this.url('my-memberships'), {
      errorMessage: 'Failed to load your firm memberships',
    });
    return Array.isArray(body.memberships) ? body.memberships : [];
  }
}

const userService = new UserService();
export default userService;

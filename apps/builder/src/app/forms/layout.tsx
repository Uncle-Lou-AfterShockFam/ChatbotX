import Image from "next/image"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { getTenantSettings } from "@/features/tenant/utils"

/**
 * Public form pages (s200): the branded frame (logo, muted background, theme
 * switcher) around `/forms/[workspaceId]/[slug]`; the page hides the header
 * and the switcher in embed mode.
 */
export default async function PublicFormLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { name, logoLightUrl, logoDarkUrl } = await getTenantSettings()

  return (
    <div
      className="flex min-h-svh flex-col items-center bg-muted p-4 group-data-[embed=true]:bg-transparent md:p-10"
      data-slot="public-form-shell"
    >
      <header
        className="flex w-full max-w-2xl items-center justify-center py-4"
        data-slot="public-form-header"
      >
        <Image
          alt={name}
          className="block h-10 w-auto dark:hidden"
          height={40}
          priority={true}
          src={logoDarkUrl}
          width={135}
        />
        <Image
          alt={name}
          className="hidden h-10 w-auto dark:block"
          height={40}
          priority={true}
          src={logoLightUrl}
          width={135}
        />
      </header>
      <div className="flex w-full max-w-2xl flex-1 flex-col gap-6">
        {children}
      </div>
      <div className="fixed inset-e-2 bottom-2" data-slot="public-form-theme">
        <ThemeSwitcher />
      </div>
    </div>
  )
}

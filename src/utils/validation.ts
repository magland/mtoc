export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateProjectName(
  name: string,
  existingNames: string[] = []
): ValidationResult {
  if (!name.trim()) {
    return { valid: false, error: "Project name cannot be empty" };
  }
  if (/\s/.test(name)) {
    return { valid: false, error: "Project name cannot contain spaces" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Project name can only contain letters, numbers, dashes, and underscores",
    };
  }
  if (name.length < 1 || name.length > 50) {
    return { valid: false, error: "Project name must be 1-50 characters" };
  }
  if (existingNames.includes(name)) {
    return { valid: false, error: "A project with this name already exists" };
  }
  const reserved = ["project", "new", "create", "delete", "share"];
  if (reserved.includes(name.toLowerCase())) {
    return { valid: false, error: "This project name is reserved" };
  }
  return { valid: true };
}

% Curated v1-compatible subset of numbl's data_structures/test_struct_basics.m.
% Excludes: isstruct/isfield/fieldnames/class(), s.(name), cell-valued fields,
% different-type field overwrites, and string-valued char fields (not yet
% supported as struct fields).

%% Struct creation via dot notation (numeric fields only — v1 doesn't
%% accept the string-valued 'name' field from the upstream test).
s.age = 30;
s.score = 95.5;

%% Field access
assert(s.age == 30);
assert(abs(s.score - 95.5) < 1e-10);

%% Modify existing field
s.age = 31;
assert(s.age == 31);

%% Add new field to existing struct (allowed: pre-pass sees the union)
s.active = true;
assert(s.active == true);

%% struct() constructor with field-value pairs
s2 = struct('x', 10, 'y', 20, 'z', 30);
assert(s2.x == 10);
assert(s2.y == 20);
assert(s2.z == 30);

%% Empty struct
s3 = struct();
% No fields to test; just confirm the predeclaration / disp round-trips.
disp(s3);

%% Nested struct creation
p.position.x = 3;
p.position.y = 4;
assert(p.position.x == 3);
assert(p.position.y == 4);

%% Deeper nesting (numeric-only)
config.server.database.port = 5432;
assert(config.server.database.port == 5432);

%% Struct field containing array
s5.data = [1, 2, 3, 4, 5];
% Indexing into a struct field requires assigning to a name first in v1.
v = s5.data;
assert(v(3) == 3);

disp('SUCCESS')

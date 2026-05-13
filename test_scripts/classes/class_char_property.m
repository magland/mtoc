% Constructor writes a char-array property. The pre-pass predicts
% the property's eventual C type from the arg's type, so the
% receiver typedef matches the body's writes.
classdef Tag
  properties
    label
    n
  end
  methods
    function obj = Tag(s, v)
      obj.label = s;
      obj.n = v;
    end
  end
end

t = Tag('hello', 7);
disp(t.label);
disp(t.n);

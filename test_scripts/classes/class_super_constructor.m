% Child constructor delegates to parent's constructor via
% `obj = obj@Parent(args)`. The parent's constructor body is
% specialized against the child's flattened typedef — its property
% writes land on the child's struct directly.
classdef Shape
  properties
    width
    height
  end
  methods
    function obj = Shape(w, h)
      obj.width = w;
      obj.height = h;
    end
  end
end

classdef Box < Shape
  properties
    depth
  end
  methods
    function obj = Box(w, h, d)
      obj = obj@Shape(w, h);
      obj.depth = d;
    end
  end
end

b = Box(2, 3, 5);
disp(b.width);
disp(b.height);
disp(b.depth);
